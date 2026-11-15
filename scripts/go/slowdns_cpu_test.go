package main

import (
	"bytes"
	"errors"
	"io"
	"log"
	"math/rand"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"www.bamsoftware.com/git/dnstt.git/dns"
	"www.bamsoftware.com/git/dnstt.git/turbotunnel"
)

// sc-fast13 (V.1FSC.136): hemat CPU per query. Uji: satu alokasi nama query
// identik dengan upstream, log per query dibatasi, query yang dibuang
// dihitung, -udp beberapa alamat, semantik timer sendLoop tetap, jawaban dari
// soket asal query, dan batch baca/tulis (logika diuji dengan batch tiruan).

func scSetBatchSize(t *testing.T, n int) {
	t.Helper()
	scBatchOnce.Do(func() {})
	old := scBatchN
	scBatchN = n
	t.Cleanup(func() { scBatchN = old })
}

func TestSCJoinUpperDecodeBufMatchesUpstream(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	alphabet := []byte("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ234567-_\xc3\xa9\x80=")
	for iter := 0; iter < 5000; iter++ {
		var labels [][]byte
		for n := rng.Intn(5); n >= 0; n-- {
			l := make([]byte, rng.Intn(64))
			for i := range l {
				if iter%3 == 0 {
					l[i] = alphabet[rng.Intn(len(alphabet))]
				} else {
					l[i] = alphabet[rng.Intn(32)] // base32 valid (huruf kecil/besar)
				}
			}
			labels = append(labels, l)
		}
		wantEnc := bytes.ToUpper(bytes.Join(labels, nil))
		want := make([]byte, base32Encoding.DecodedLen(len(wantEnc)))
		wn, werr := base32Encoding.Decode(want, wantEnc)
		enc, payload := scJoinUpperDecodeBuf(labels)
		if len(payload) != base32Encoding.DecodedLen(len(enc)) {
			t.Fatalf("buffer decode %d, harus %d", len(payload), base32Encoding.DecodedLen(len(enc)))
		}
		gn, gerr := base32Encoding.Decode(payload, enc)
		if (werr == nil) != (gerr == nil) {
			t.Fatalf("hasil decode beda untuk %q: upstream %v, sc %v", bytes.Join(labels, nil), werr, gerr)
		}
		if werr == nil && !bytes.Equal(want[:wn], payload[:gn]) {
			t.Fatalf("payload beda untuk %q", bytes.Join(labels, nil))
		}
		if bytes.IndexFunc(bytes.Join(labels, nil), func(r rune) bool { return r >= 0x80 || r == 0xfffd }) < 0 && !bytes.Equal(enc, wantEnc) {
			t.Fatalf("gabungan label beda: %q vs %q", enc, wantEnc)
		}
	}
}

func TestSCResponseForSameAsUpstreamJoin(t *testing.T) {
	domain, _ := dns.ParseName("t.local.test")
	for _, payload := range [][]byte{nil, []byte("halo"), bytes.Repeat([]byte{0xab}, 120)} {
		wire, _, cid := scRecvQuery(t, rrTypeNULL, payload)
		q, err := dns.MessageFromWireFormat(wire)
		if err != nil {
			t.Fatal(err)
		}
		// Huruf kecil di nama (resolver 0x20) tetap didecode sama.
		for i, l := range q.Question[0].Name[:len(q.Question[0].Name)-3] {
			q.Question[0].Name[i] = bytes.ToLower(l)
		}
		resp, got := responseFor(&q, domain)
		if resp == nil || resp.Rcode() != dns.RcodeNoError {
			t.Fatalf("respons tidak NoError: %+v", resp)
		}
		if !bytes.Equal(got[:8], cid[:]) {
			t.Fatalf("ClientID salah: %x", got[:8])
		}
	}
}

func TestSCLogfLimitsPerFormat(t *testing.T) {
	var out bytes.Buffer
	log.SetOutput(&out)
	defer log.SetOutput(os.Stderr)
	scLogMu.Lock()
	scLogCounts = map[string]*scLogCount{}
	scLogMu.Unlock()
	for i := 0; i < 50; i++ {
		scLogf("NXDOMAIN: not authoritative for %s", "x.example.")
	}
	scLogf("cannot parse DNS query: %v", "rusak")
	if n := strings.Count(out.String(), "not authoritative"); n != scLogBurst {
		t.Fatalf("log per query harus dibatasi %d baris per menit, tertulis %d", scLogBurst, n)
	}
	if !strings.Contains(out.String(), "cannot parse DNS query: rusak") {
		t.Fatal("format lain punya jatah sendiri")
	}
	out.Reset()
	atomic.StoreUint64(&scRecordDrop, 3)
	scCPUReportOnce(100)
	got := out.String()
	if !strings.Contains(got, "antrean jawaban penuh: 3 query dibuang") || !strings.Contains(got, `45 x "NXDOMAIN: not authoritative for %s"`) {
		t.Fatalf("ringkasan per menit salah:\n%s", got)
	}
	out.Reset()
	scCPUReportOnce(100)
	if out.Len() != 0 {
		t.Fatalf("tanpa kejadian baru tidak ada ringkasan: %s", out.String())
	}
}

func TestSCRecordQueueFullIsCounted(t *testing.T) {
	domain, _ := dns.ParseName("t.local.test")
	wire, _, cid := scRecvQuery(t, rrTypeNULL, nil)
	defer clientEdnsForget(cid)
	atomic.StoreUint64(&scRecordDrop, 0)
	records := make(chan *record, 2)
	conn := &scRecvConn{packets: [][]byte{wire}, limit: 5}
	if err := recvLoop(domain, conn, nil, records); err != io.EOF {
		t.Fatal(err)
	}
	if len(records) != 2 || atomic.LoadUint64(&scRecordDrop) != 3 {
		t.Fatalf("antrean %d, dibuang %d (harus 2 dan 3)", len(records), atomic.LoadUint64(&scRecordDrop))
	}
	if r := <-records; r.Conn != conn {
		t.Fatal("record wajib membawa soket asal query")
	}
}

func TestSCListenUDPMultiple(t *testing.T) {
	main, extra, err := scListenUDP("127.0.0.1:0, 127.0.0.1:0")
	if err != nil || len(extra) != 1 {
		t.Fatalf("dua alamat: %v %d", err, len(extra))
	}
	main.Close()
	extra[0].Close()
	// Alamat yang gagal di-bind dilewati selama ada yang berhasil.
	busy, _ := net.ListenPacket("udp", "127.0.0.1:0")
	defer busy.Close()
	main, extra, err = scListenUDP(busy.LocalAddr().String() + ",127.0.0.1:0")
	if err != nil || len(extra) != 0 || main.LocalAddr().String() == busy.LocalAddr().String() {
		t.Fatalf("alamat sibuk harus dilewati: %v", err)
	}
	main.Close()
	if _, _, err = scListenUDP(busy.LocalAddr().String()); err == nil {
		t.Fatal("satu alamat gagal = error (perilaku lama)")
	}
	if _, _, err = scListenUDP(" , "); err == nil {
		t.Fatal("daftar kosong = error")
	}
}

// ── sendLoop ───────────────────────────────────────────────────────────────

type scSent struct {
	conn net.PacketConn
	buf  []byte
	at   time.Time
}

type scWriteConn struct {
	net.PacketConn
	mu   sync.Mutex
	sent *[]scSent
	err  error
}

func (c *scWriteConn) WriteTo(b []byte, addr net.Addr) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return 0, c.err
	}
	*c.sent = append(*c.sent, scSent{c, append([]byte(nil), b...), time.Now()})
	return len(b), nil
}

func (c *scWriteConn) LocalAddr() net.Addr { return scRecvAddr }

func scLoopRecord(t *testing.T, cid turbotunnel.ClientID, conn net.PacketConn) *record {
	t.Helper()
	domain, _ := dns.ParseName("t.local.test")
	wire, _, _ := scRecvQuery(t, rrTypeNULL, nil)
	q, err := dns.MessageFromWireFormat(wire)
	if err != nil {
		t.Fatal(err)
	}
	resp, _ := responseFor(&q, domain)
	return &record{Resp: resp, Addr: scRecvAddr, ClientID: cid, Size: 1232, Conn: conn}
}

func scAnswerPayload(t *testing.T, wire []byte) []byte {
	t.Helper()
	m, err := dns.MessageFromWireFormat(wire)
	if err != nil || len(m.Answer) != 1 {
		t.Fatalf("jawaban rusak: %v", err)
	}
	return m.Answer[0].Data
}

func TestSCSendLoopTimerSemantics(t *testing.T) {
	scSetBatchSize(t, 0)
	var sent []scSent
	var mu sync.Mutex
	conn := &scWriteConn{sent: &sent}
	tt := turbotunnel.NewQueuePacketConn(turbotunnel.DummyAddr{}, time.Minute)
	defer tt.Close()
	ch := make(chan *record, 4)
	done := make(chan error, 1)
	go func() { done <- sendLoop(conn, tt, ch, 1000) }()
	count := func() int { mu.Lock(); defer mu.Unlock(); conn.mu.Lock(); defer conn.mu.Unlock(); return len(sent) }
	waitFor := func(n int, max time.Duration) time.Duration {
		start := time.Now()
		for count() < n {
			if time.Since(start) > max {
				t.Fatalf("jawaban ke-%d tidak terkirim dalam %v", n, max)
			}
			time.Sleep(5 * time.Millisecond)
		}
		return time.Since(start)
	}
	var cid turbotunnel.ClientID
	cid[0] = 0x51
	defer clientEdnsForget(cid)

	// 1. Tanpa data: jawaban kosong setelah maxResponseDelay.
	ch <- scLoopRecord(t, cid, conn)
	if d := waitFor(1, 3*time.Second); d < maxResponseDelay-100*time.Millisecond {
		t.Fatalf("jawaban kosong terlalu cepat (%v), harus menunggu %v", d, maxResponseDelay)
	}
	// 2. Query baru mendahului: query lama langsung dijawab kosong.
	ch <- scLoopRecord(t, cid, conn)
	time.Sleep(100 * time.Millisecond)
	ch <- scLoopRecord(t, cid, conn)
	if d := waitFor(2, 500*time.Millisecond); d > 400*time.Millisecond {
		t.Fatalf("query baru tidak mendahului jawaban lama (%v)", d)
	}
	waitFor(3, 3*time.Second)
	// 3. Data sudah antre: beberapa paket dibundel dalam satu jawaban, tanpa menunggu.
	for _, p := range [][]byte{[]byte("satu"), []byte("dua"), []byte("tiga")} {
		tt.WriteTo(p, cid)
	}
	ch <- scLoopRecord(t, cid, conn)
	if d := waitFor(4, 500*time.Millisecond); d > 300*time.Millisecond {
		t.Fatalf("jawaban berisi data tertahan %v", d)
	}
	conn.mu.Lock()
	data := scAnswerPayload(t, sent[3].buf)
	conn.mu.Unlock()
	want := []byte{0, 4, 's', 'a', 't', 'u', 0, 3, 'd', 'u', 'a', 0, 4, 't', 'i', 'g', 'a'}
	if !bytes.Equal(data, want) {
		t.Fatalf("bundel paket salah: %x", data)
	}
	// 4. Data datang saat menunggu: jawaban langsung terkirim.
	ch <- scLoopRecord(t, cid, conn)
	time.Sleep(150 * time.Millisecond)
	tt.WriteTo([]byte("empat"), cid)
	if d := waitFor(5, 400*time.Millisecond); d > 300*time.Millisecond {
		t.Fatalf("paket pertama yang datang saat menunggu tertahan %v", d)
	}
	close(ch)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestSCSendLoopRepliesFromQuerySocket(t *testing.T) {
	for _, batch := range []int{0, 4} {
		scSetBatchSize(t, batch)
		var sent []scSent
		a, b := &scWriteConn{sent: &sent}, &scWriteConn{sent: &sent}
		tt := turbotunnel.NewQueuePacketConn(turbotunnel.DummyAddr{}, time.Minute)
		ch := make(chan *record, 8)
		var cid turbotunnel.ClientID
		cid[0] = 0x52
		for i := 0; i < 3; i++ {
			tt.WriteTo([]byte{byte(i)}, cid)
		}
		ch <- scLoopRecord(t, cid, b)
		ch <- scLoopRecord(t, cid, a)
		ch <- scLoopRecord(t, cid, nil) // record lama tanpa Conn: soket utama
		close(ch)
		if err := sendLoop(a, tt, ch, 1000); err != nil {
			t.Fatal(err)
		}
		tt.Close()
		clientEdnsForget(cid)
		if len(sent) != 3 || sent[0].conn != b || sent[1].conn != a || sent[2].conn != a {
			t.Fatalf("batch %d: jawaban harus keluar dari soket asal query: %d", batch, len(sent))
		}
	}
}

func TestSCSendLoopClosedSocketStops(t *testing.T) {
	scSetBatchSize(t, 0)
	var sent []scSent
	conn := &scWriteConn{sent: &sent, err: net.ErrClosed}
	tt := turbotunnel.NewQueuePacketConn(turbotunnel.DummyAddr{}, time.Minute)
	defer tt.Close()
	var cid turbotunnel.ClientID
	cid[0] = 0x53
	tt.WriteTo([]byte("x"), cid)
	ch := make(chan *record, 1)
	ch <- scLoopRecord(t, cid, conn)
	if err := sendLoop(conn, tt, ch, 1000); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("soket tertutup harus menghentikan sendLoop: %v", err)
	}
}

// ── Batch tiruan ───────────────────────────────────────────────────────────

type scFakeBatch struct {
	mu      sync.Mutex
	reads   [][]scMsg
	readErr error
	writes  [][]string
	failAt  map[string]error // payload -> error saat paket itu di depan batch
	limit   int              // maks paket per writeBatch (0 = semua)
}

func (f *scFakeBatch) readBatch(ms []scMsg) (int, error) {
	if len(f.reads) == 0 {
		return 0, f.readErr
	}
	next := f.reads[0]
	f.reads = f.reads[1:]
	for i, m := range next {
		ms[i].n = copy(ms[i].buf, m.buf)
		ms[i].addr = m.addr
	}
	return len(next), nil
}

func (f *scFakeBatch) writeBatch(ms []scMsg) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.failAt[string(ms[0].buf[:ms[0].n])]; err != nil {
		delete(f.failAt, string(ms[0].buf[:ms[0].n]))
		return 0, err
	}
	n := len(ms)
	if f.limit > 0 && n > f.limit {
		n = f.limit
	}
	var got []string
	for _, m := range ms[:n] {
		got = append(got, string(m.buf[:m.n]))
	}
	f.writes = append(f.writes, got)
	return n, nil
}

func scUseFakeBatch(t *testing.T, f *scFakeBatch) {
	t.Helper()
	old := scNewBatchIO
	scNewBatchIO = func(net.PacketConn) scBatchIO {
		if f == nil {
			return nil
		}
		return f
	}
	t.Cleanup(func() { scNewBatchIO = old })
}

func TestSCPacketReaderBatch(t *testing.T) {
	scSetBatchSize(t, 4)
	a1 := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 1}
	a2 := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 2), Port: 2}
	f := &scFakeBatch{reads: [][]scMsg{{{buf: []byte("q1"), addr: a1}, {buf: []byte("q2"), addr: a2}}, {{buf: []byte("q3"), addr: a1}}}, readErr: io.EOF}
	scUseFakeBatch(t, f)
	r := scNewPacketReader(&scRecvConn{})
	for _, want := range []struct {
		p    string
		addr net.Addr
	}{{"q1", a1}, {"q2", a2}, {"q3", a1}} {
		p, addr, err := r.read()
		if err != nil || string(p) != want.p || addr != want.addr {
			t.Fatalf("baca batch: %q %v %v", p, addr, err)
		}
	}
	if _, _, err := r.read(); err != io.EOF {
		t.Fatalf("error batch diteruskan: %v", err)
	}
	// recvmmsg tidak didukung: kembali ke ReadFrom satu per satu.
	wire, _, _ := scRecvQuery(t, rrTypeNULL, nil)
	f = &scFakeBatch{readErr: &net.OpError{Op: "read", Err: os.NewSyscallError("recvmmsg", errors.New("ENOSYS"))}}
	scUseFakeBatch(t, f)
	r = scNewPacketReader(&scRecvConn{packets: [][]byte{wire}, limit: 1})
	if p, _, err := r.read(); err != nil || !bytes.Equal(p, wire) {
		t.Fatalf("fallback ReadFrom: %v", err)
	}
}

func TestSCPacketWriterBatch(t *testing.T) {
	scSetBatchSize(t, 3)
	f := &scFakeBatch{failAt: map[string]error{"p5": errors.New("sendmmsg: operation not permitted")}}
	scUseFakeBatch(t, f)
	var sent []scSent
	a, b := &scWriteConn{sent: &sent}, &scWriteConn{sent: &sent}
	w := scNewPacketWriter()
	send := func(c net.PacketConn, p string) {
		if err := w.send(c, []byte(p), scRecvAddr); err != nil {
			t.Fatal(err)
		}
	}
	send(a, "p1")
	send(a, "p2")
	if len(f.writes) != 0 {
		t.Fatal("batch belum penuh tidak boleh dikirim")
	}
	send(a, "p3") // penuh -> terkirim
	send(a, "p4")
	send(b, "p5") // soket lain -> batch soket a dikirim dulu
	send(b, "p6")
	if err := w.flush(); err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, wr := range f.writes {
		got = append(got, strings.Join(wr, "+"))
	}
	// p5 gagal di depan batch: dilewati (dilog), p6 tetap terkirim.
	if strings.Join(got, " ") != "p1+p2+p3 p4 p6" {
		t.Fatalf("urutan batch salah: %v", got)
	}
	// Kirim sebagian: sisa batch dikirim di panggilan berikutnya.
	f.writes, f.limit = nil, 2
	for _, p := range []string{"x1", "x2", "x3"} {
		send(a, p)
	}
	if len(f.writes) != 2 || strings.Join(f.writes[1], "+") != "x3" {
		t.Fatalf("kirim sebagian: %v", f.writes)
	}
	// sendmmsg tidak didukung: kembali ke WriteTo satu per satu.
	f.limit = 0
	f.failAt = map[string]error{"y1": &net.OpError{Op: "write", Err: os.NewSyscallError("sendmmsg", errors.New("ENOSYS"))}}
	send(a, "y1")
	send(a, "y2")
	if err := w.flush(); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 2 || string(sent[0].buf) != "y1" || string(sent[1].buf) != "y2" {
		t.Fatalf("fallback WriteTo: %d", len(sent))
	}
	// Soket tertutup menghentikan pengiriman.
	f2 := &scFakeBatch{failAt: map[string]error{"z": &net.OpError{Op: "write", Err: net.ErrClosed}}}
	scUseFakeBatch(t, f2)
	w = scNewPacketWriter()
	w.send(a, []byte("z"), scRecvAddr)
	if err := w.flush(); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("soket tertutup: %v", err)
	}
}

// Batch tidak boleh menahan jawaban saat sendLoop akan menunggu: jawaban yang
// sudah jadi dikirim sebelum sendLoop memblok di antrean query/data.
func TestSCSendLoopFlushesBeforeWaiting(t *testing.T) {
	scSetBatchSize(t, 16)
	f := &scFakeBatch{}
	scUseFakeBatch(t, f)
	var sent []scSent
	conn := &scWriteConn{sent: &sent}
	tt := turbotunnel.NewQueuePacketConn(turbotunnel.DummyAddr{}, time.Minute)
	defer tt.Close()
	var cid turbotunnel.ClientID
	cid[0] = 0x54
	defer clientEdnsForget(cid)
	tt.WriteTo([]byte("a"), cid)
	ch := make(chan *record, 4)
	ch <- scLoopRecord(t, cid, conn)
	ch <- scLoopRecord(t, cid, conn) // menunggu data -> batch berisi jawaban pertama dikirim
	go sendLoop(conn, tt, ch, 1000)
	deadline := time.Now().Add(500 * time.Millisecond)
	for {
		f.mu.Lock()
		n := len(f.writes)
		f.mu.Unlock()
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("jawaban pertama tertahan di batch saat sendLoop menunggu")
		}
		time.Sleep(5 * time.Millisecond)
	}
	close(ch)
}

func BenchmarkSCResponseFor(b *testing.B) {
	domain, _ := dns.ParseName("t.local.test")
	wire, _, _ := scRecvQuery(b, rrTypeNULL, bytes.Repeat([]byte{1}, 100))
	q, _ := dns.MessageFromWireFormat(wire)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		responseFor(&q, domain)
	}
}
