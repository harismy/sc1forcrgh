package main

import (
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xtaci/kcp-go/v5"
	"www.bamsoftware.com/git/dnstt.git/noise"
	"www.bamsoftware.com/git/dnstt.git/turbotunnel"
)

// sc-fast9: penjaga banjir sesi palsu. Salin ke paket dnstt-server.

func scResetEdnsMaps() {
	clientEdnsMu.Lock()
	clientEdns = make(map[turbotunnel.ClientID]int)
	clientKinds = make(map[turbotunnel.ClientID]uint16)
	clientSeen = make(map[turbotunnel.ClientID]int64)
	scEdnsLastSweep = 0
	clientEdnsMu.Unlock()
}

func scCid(n int) turbotunnel.ClientID {
	var c turbotunnel.ClientID
	c[0], c[1], c[2], c[3] = byte(n>>24), byte(n>>16), byte(n>>8), byte(n)
	c[7] = 0xa5
	return c
}

func TestSCHandshakeTimeoutParse(t *testing.T) {
	cases := []struct {
		raw  string
		want time.Duration
		ok   bool
	}{
		{"", 30 * time.Second, true}, {"30", 30 * time.Second, true}, {" 5 ", 5 * time.Second, true},
		{"3", 3 * time.Second, true}, {"300", 300 * time.Second, true},
		{"2", 30 * time.Second, false}, {"0", 30 * time.Second, false}, {"301", 30 * time.Second, false},
		{"-5", 30 * time.Second, false}, {"30s", 30 * time.Second, false}, {"abc", 30 * time.Second, false},
		{"99999999999999999999", 30 * time.Second, false},
	}
	for _, c := range cases {
		got, ok := scParseHandshakeTimeout(c.raw)
		if got != c.want || ok != c.ok {
			t.Errorf("handshake %q = %v,%v; want %v,%v", c.raw, got, ok, c.want, c.ok)
		}
	}
}

func TestSCUDPRcvbufParse(t *testing.T) {
	cases := []struct {
		raw  string
		want int
		ok   bool
	}{
		{"", 2 << 20, true}, {"0", 0, true}, {"65536", 65536, true}, {" 4194304 ", 4194304, true},
		{"33554432", 33554432, true},
		{"65535", 2 << 20, false}, {"-1", 2 << 20, false}, {"33554433", 2 << 20, false},
		{"4M", 2 << 20, false}, {"abc", 2 << 20, false},
	}
	for _, c := range cases {
		got, ok := scParseUDPRcvbuf(c.raw)
		if got != c.want || ok != c.ok {
			t.Errorf("rcvbuf %q = %d,%v; want %d,%v", c.raw, got, ok, c.want, c.ok)
		}
	}
}

// Socket UDP sungguhan: buffer diminta tanpa error dan socket tetap bisa menerima.
func TestSCSetUDPReadBufferKeepsSocketUsable(t *testing.T) {
	c, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	t.Setenv("SLOWDNS_UDP_RCVBUF", "")
	scSetUDPReadBuffer(c)
	tx, err := net.Dial("udp", c.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Close()
	if _, err := tx.Write([]byte("q")); err != nil {
		t.Fatal(err)
	}
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 16)
	if n, _, err := c.ReadFrom(buf); err != nil || string(buf[:n]) != "q" {
		t.Fatalf("socket harus tetap menerima setelah SetReadBuffer: %q %v", buf[:n], err)
	}
}

func TestSCHandshakeErrorOnlyAfterDeadline(t *testing.T) {
	orig := errors.New("chacha20poly1305: message authentication failed")
	before := atomic.LoadUint64(&scHandshakeTimeouts)
	if got := scHandshakeError(orig, time.Now().Add(time.Minute)); got != orig {
		t.Fatalf("error sebelum tenggat harus diteruskan apa adanya, dapat %v", got)
	}
	if atomic.LoadUint64(&scHandshakeTimeouts) != before {
		t.Fatal("error sebelum tenggat tidak boleh dihitung timeout")
	}
	if got := scHandshakeError(orig, time.Now().Add(-time.Millisecond)); !errors.Is(got, errSCHandshakeTimeout) {
		t.Fatalf("error setelah tenggat harus errSCHandshakeTimeout, dapat %v", got)
	}
	if atomic.LoadUint64(&scHandshakeTimeouts) != before+1 {
		t.Fatal("timeout handshake harus dihitung")
	}
	if scHandshakeError(nil, time.Now().Add(-time.Second)) != nil {
		t.Fatal("handshake sukses tidak boleh jadi error")
	}
}

// Map EDNS penuh oleh ClientID sampah: entri basi dibuang saat ClientID baru
// datang, entri klien hidup tetap, dan sapuan dibatasi tiap scEdnsSweepEvery.
func TestSCEdnsSweepDropsOnlyStaleEntries(t *testing.T) {
	scResetEdnsMaps()
	defer scResetEdnsMaps()
	now := time.Now().Unix()
	clientEdnsMu.Lock()
	for i := 0; i < clientEdnsMax; i++ {
		cid := scCid(i)
		clientEdns[cid] = 512
		clientKinds[cid] = 16
		if i%2 == 0 {
			clientSeen[cid] = now - scEdnsTTL - 5 // basi
		} else {
			clientSeen[cid] = now // klien hidup
		}
	}
	clientEdnsMu.Unlock()

	fresh := scCid(clientEdnsMax + 1)
	clientEdnsRecord(fresh, 1232, 10)
	if got := clientEdnsSize(fresh); got != 1232 {
		t.Fatalf("klien baru setelah map penuh harus tercatat 1232, dapat %d", got)
	}
	clientEdnsMu.Lock()
	n, kinds, seen := len(clientEdns), len(clientKinds), len(clientSeen)
	_, liveOK := clientEdns[scCid(1)]
	_, staleOK := clientEdns[scCid(0)]
	clientEdnsMu.Unlock()
	if n != clientEdnsMax/2+1 || kinds != n || seen != n {
		t.Fatalf("setelah sapuan: edns=%d kinds=%d seen=%d; want %d semua", n, kinds, seen, clientEdnsMax/2+1)
	}
	if !liveOK || staleOK {
		t.Fatalf("entri hidup harus tetap (%v) dan entri basi harus hilang (%v)", liveOK, !staleOK)
	}

	// Map penuh lagi oleh entri segar: sapuan berikutnya ditahan sampai jedanya lewat.
	clientEdnsMu.Lock()
	for i := 0; len(clientEdns) < clientEdnsMax; i++ {
		cid := scCid(1<<20 + i)
		clientEdns[cid] = 512
		clientSeen[cid] = now - scEdnsTTL - 5
	}
	clientEdnsMu.Unlock()
	late := scCid(1<<21 + 7)
	clientEdnsRecord(late, 1232)
	if got := clientEdnsSize(late); got != 0 {
		t.Fatalf("sapuan kedua dalam %d detik harus ditahan, klien tercatat %d", scEdnsSweepEvery, got)
	}

	clientEdnsForget(fresh)
	clientEdnsMu.Lock()
	_, a := clientEdns[fresh]
	_, b := clientSeen[fresh]
	_, c := clientKinds[fresh]
	clientEdnsMu.Unlock()
	if a || b || c {
		t.Fatal("clientEdnsForget harus menghapus edns, kind, dan seen")
	}
}

// Ujung ke ujung: paket sampah membuat sesi KCP sungguhan. Sesi itu wajib
// ditutup setelah tenggat handshake, dan entri EDNS-nya ikut hilang.
func TestSCJunkSessionClosedAfterHandshakeTimeout(t *testing.T) {
	scResetEdnsMaps()
	defer scResetEdnsMaps()
	t.Setenv("SLOWDNS_HANDSHAKE_TIMEOUT", "3")
	privkey, err := noise.GeneratePrivkey()
	if err != nil {
		t.Fatal(err)
	}
	tt := turbotunnel.NewQueuePacketConn(turbotunnel.DummyAddr{}, time.Minute)
	defer tt.Close()
	ln, err := kcp.ServeConn(nil, 0, 0, tt)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go acceptSessions(ln, privkey, 500, 1000, "127.0.0.1:9")

	before := atomic.LoadUint64(&scHandshakeTimeouts)
	cid := scCid(42)
	clientEdnsRecord(cid, 1232)
	junk := make([]byte, 30)
	for i := range junk {
		junk[i] = byte(0x30 + i)
	}
	tt.QueueIncoming(junk, cid)

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadUint64(&scHandshakeTimeouts) > before && clientEdnsSize(cid) == 0 {
			if time.Until(deadline) > 9*time.Second {
				t.Fatal("sesi ditutup sebelum tenggat 3 detik")
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("sesi tanpa handshake tidak ditutup (timeout=%d, edns=%d)",
		atomic.LoadUint64(&scHandshakeTimeouts)-before, clientEdnsSize(cid))
}
