package main

import (
	"bytes"
	"encoding/binary"
	"testing"
	"time"

	"github.com/xtaci/kcp-go/v5"
	"www.bamsoftware.com/git/dnstt.git/dns"
	"www.bamsoftware.com/git/dnstt.git/turbotunnel"
)

// sc-fast11: ukuran respons terbukti per klien. Salin ke paket dnstt-server.

func scSizeReset(t *testing.T) {
	t.Helper()
	saved := maxUDPPayload
	savedCeil := scMTUCeil
	maxUDPPayload = 1232
	scMTUCeil = computeMaxEncodedPayload(1232) - 2
	clientEdnsMu.Lock()
	clientSize = make(map[turbotunnel.ClientID]*scSizeState)
	clientEdnsMu.Unlock()
	t.Cleanup(func() {
		maxUDPPayload = saved
		scMTUCeil = savedCeil
		clientEdnsMu.Lock()
		clientSize = make(map[turbotunnel.ClientID]*scSizeState)
		clientEdnsMu.Unlock()
	})
}

func scSizeFresh(cid turbotunnel.ClientID) *scSizeState {
	st := &scSizeState{proven: scSizeFloor, ceil: maxUDPPayload, top: maxUDPPayload, failedAt: maxUDPPayload + 1, mtu: 215}
	clientEdnsMu.Lock()
	clientSize[cid] = st
	clientEdnsMu.Unlock()
	return st
}

// scSeg menyusun satu segmen KCP (little-endian, header 24 byte).
func scSeg(cmd byte, sn, ts, una uint32, data int) []byte {
	b := make([]byte, scKCPOverhead+data)
	binary.LittleEndian.PutUint32(b[0:], 0x01020304)
	b[4] = cmd
	binary.LittleEndian.PutUint16(b[6:], 128)
	binary.LittleEndian.PutUint32(b[8:], ts)
	binary.LittleEndian.PutUint32(b[12:], sn)
	binary.LittleEndian.PutUint32(b[16:], una)
	binary.LittleEndian.PutUint32(b[20:], uint32(data))
	return b
}

// scFramed menyusun payload respons seperti sendLoop (panjang 2 byte BE).
func scFramed(packets ...[]byte) []byte {
	var b bytes.Buffer
	for _, p := range packets {
		binary.Write(&b, binary.BigEndian, uint16(len(p)))
		b.Write(p)
	}
	return b.Bytes()
}

func scSizeRec(cid turbotunnel.ClientID, kind uint16, size int) *record {
	name := dns.Name{[]byte("aaaa"), []byte("t"), []byte("example"), []byte("com")}
	return &record{
		Resp:     &dns.Message{Question: []dns.Question{{Name: name, Type: kind, Class: dns.ClassIN}}},
		ClientID: cid,
		Size:     size,
	}
}

func TestSCSizeCapsWithoutStateStayAt512(t *testing.T) {
	scSizeReset(t)
	cid := scCid(1)
	for _, kind := range []uint16{dns.RRTypeTXT, rrTypeNULL} {
		plan := scSizeCaps(scSizeRec(cid, kind, 1232))
		if plan.base != 512 || plan.probe != 0 || plan.track {
			t.Fatalf("klien tanpa sesi harus dibatasi 512 tanpa probe: %+v", plan)
		}
	}
	// Tipe lain punya MTU sendiri; ukurannya tidak diubah sc-fast11.
	if plan := scSizeCaps(scSizeRec(cid, 1, 1232)); plan.base != 1232 || plan.probe != 0 {
		t.Fatalf("tipe A tidak boleh dibatasi: %+v", plan)
	}
	// Resolver/klien yang mengiklankan 512 tidak pernah diprobe.
	scSizeFresh(cid)
	if plan := scSizeCaps(scSizeRec(cid, rrTypeNULL, 512)); plan.base != 512 || plan.probe != 0 {
		t.Fatalf("EDNS 512 tidak boleh diprobe: %+v", plan)
	}
}

func TestSCSizeProbeProvenByUna(t *testing.T) {
	scSizeReset(t)
	cid := scCid(2)
	st := scSizeFresh(cid)
	plan := scSizeCaps(scSizeRec(cid, rrTypeNULL, 1232))
	if plan.base != 512 || plan.probe != 1232 || !plan.track || plan.fresh != 0 {
		t.Fatalf("rencana awal salah: %+v", plan)
	}
	payload := scFramed(scSeg(scKCPCmdPush, 0, 100, 0, 150), scSeg(scKCPCmdPush, 1, 100, 0, 150), scSeg(scKCPCmdPush, 2, 100, 0, 150))
	scSizeSent(cid, payload, 1100, 1232)
	if st.pendingSize != 1232 || st.freshSn != 3 || st.watchUntil == 0 {
		t.Fatalf("probe tidak tercatat: %+v", *st)
	}
	clientEdnsMu.Lock()
	watch := scSizeWatchLocked(cid)
	clientEdnsMu.Unlock()
	if !watch {
		t.Fatal("klien yang sedang diuji harus dibaca header KCP-nya")
	}
	// Selama probe menunggu, tidak ada probe kedua.
	if plan := scSizeCaps(scSizeRec(cid, rrTypeNULL, 1232)); plan.probe != 0 || plan.base != 512 {
		t.Fatalf("probe ganda: %+v", plan)
	}
	// una klien belum melewati segmen probe: belum bukti.
	scSizeCheckClient(cid, scSeg(scKCPCmdAck, 9, 1, 0, 0))
	if st.proven != 512 {
		t.Fatalf("una 0 tidak boleh membuktikan apa pun: %d", st.proven)
	}
	scSizeCheckClient(cid, scSeg(scKCPCmdAck, 9, 1, 2, 0))
	if st.proven != 1232 || st.pendingSize != 0 || st.ceil != 1232 || st.watchUntil != 0 {
		t.Fatalf("una 2 harus membuktikan 1232 dan menghentikan pengujian: %+v", *st)
	}
	if plan := scSizeCaps(scSizeRec(cid, rrTypeNULL, 1232)); plan.base != 1232 || plan.probe != 0 || plan.track {
		t.Fatalf("setelah terbukti, respons penuh tanpa pencatatan: %+v", plan)
	}
}

func TestSCSizeRetransmissionIsNotProof(t *testing.T) {
	scSizeReset(t)
	cid := scCid(3)
	st := scSizeFresh(cid)
	// sn 0..4 sudah dikirim di respons biasa (tercatat karena sesi diuji).
	scSizeSent(cid, scFramed(scSeg(scKCPCmdPush, 0, 1, 0, 10), scSeg(scKCPCmdPush, 4, 1, 0, 10)), 300, 0)
	if st.freshSn != 5 || st.pendingSize != 0 {
		t.Fatalf("respons biasa tidak boleh jadi probe: %+v", *st)
	}
	// Probe berisi kiriman ulang sn 3 dan data baru sn 5: hanya sn 5 dicatat.
	limit, extra, probing := -10, 500, false
	if scSizeExtend(&limit, &extra, &probing, scSeg(scKCPCmdPush, 3, 2, 0, 10), st.freshSn) || probing {
		t.Fatal("paket kiriman ulang tidak boleh memulai probe")
	}
	if scSizeExtend(&limit, &extra, &probing, scSeg(scKCPCmdAck, 9, 2, 0, 0), st.freshSn) || probing {
		t.Fatal("paket ACK saja tidak boleh memulai probe")
	}
	if !scSizeExtend(&limit, &extra, &probing, scSeg(scKCPCmdPush, 5, 2, 0, 10), st.freshSn) || !probing || limit != 490 || extra != 0 {
		t.Fatalf("paket data baru harus memulai probe: %d %d %v", limit, extra, probing)
	}
	scSizeSent(cid, scFramed(scSeg(scKCPCmdPush, 3, 2, 0, 10), scSeg(scKCPCmdPush, 5, 2, 0, 10)), 1200, 1232)
	scSizeCheckClient(cid, scSeg(scKCPCmdAck, 3, 2, 4, 0))
	if st.proven != 512 {
		t.Fatalf("una melewati kiriman ulang bukan bukti: %d", st.proven)
	}
	// sn 5 dikirim ulang di respons biasa sebelum klien menerimanya.
	scSizeSent(cid, scFramed(scSeg(scKCPCmdPush, 5, 3, 0, 10)), 400, 0)
	scSizeCheckClient(cid, scSeg(scKCPCmdAck, 5, 3, 6, 0))
	if st.proven != 512 {
		t.Fatalf("una lewat salinan kiriman ulang bukan bukti: %d", st.proven)
	}
}

func TestSCSizeAckEchoProof(t *testing.T) {
	scSizeReset(t)
	cid := scCid(4)
	st := scSizeFresh(cid)
	scSizeSent(cid, scFramed(scSeg(scKCPCmdPush, 7, 1234, 0, 10)), 1000, 1232)
	scSizeCheckClient(cid, scSeg(scKCPCmdAck, 7, 999, 0, 0))
	if st.proven != 512 {
		t.Fatal("ACK dengan ts lain bukan bukti")
	}
	// Dua segmen dalam satu paket klien; ACK kedua cocok sn+ts.
	scSizeCheckClient(cid, append(scSeg(scKCPCmdAck, 1, 5, 0, 0), scSeg(scKCPCmdAck, 7, 1234, 0, 0)...))
	if st.proven != 1232 {
		t.Fatalf("ACK sn+ts yang sama harus membuktikan: %d", st.proven)
	}
}

func scSizeExpire(st *scSizeState) {
	clientEdnsMu.Lock()
	st.pendingAt = time.Now().UnixNano() - scSizeTimeout - int64(time.Millisecond)
	clientEdnsMu.Unlock()
}

// Klien 512: ukuran awal dicoba dua kali, lalu turun biner sampai berhenti.
func TestSCSizeFailLadderStopsAt512(t *testing.T) {
	scSizeReset(t)
	cid := scCid(5)
	st := scSizeFresh(cid)
	var sn uint32
	probe := func(want int) {
		t.Helper()
		plan := scSizeCaps(scSizeRec(cid, rrTypeNULL, 1232))
		if plan.probe != want {
			t.Fatalf("probe berikut %d, mau %d (%+v)", plan.probe, want, *st)
		}
		scSizeSent(cid, scFramed(scSeg(scKCPCmdPush, sn, 1, 0, 10)), want-50, plan.probe)
		sn++
		scSizeExpire(st)
	}
	probe(1232)
	probe(1232)
	probe(872)
	probe(692)
	plan := scSizeCaps(scSizeRec(cid, rrTypeNULL, 1232))
	if plan.probe != 0 || st.ceil != 512 || st.proven != 512 || plan.base != 512 {
		t.Fatalf("klien 512 harus berhenti di 512: %+v %+v", plan, *st)
	}
}

// Klien 1024: gagal 1232, terbukti 872, gagal 1052, berhenti di 872.
func TestSCSizeBinarySearchFindsMiddle(t *testing.T) {
	scSizeReset(t)
	cid := scCid(6)
	st := scSizeFresh(cid)
	var sn uint32
	send := func(want int) {
		t.Helper()
		plan := scSizeCaps(scSizeRec(cid, rrTypeNULL, 1232))
		if plan.probe != want {
			t.Fatalf("probe berikut %d, mau %d (%+v)", plan.probe, want, *st)
		}
		scSizeSent(cid, scFramed(scSeg(scKCPCmdPush, sn, 1, 0, 10)), want, plan.probe)
		sn++
	}
	send(1232)
	scSizeExpire(st)
	send(1232)
	scSizeExpire(st)
	// Segmen dua probe yang hilang dikirim ulang KCP di respons biasa.
	scSizeSent(cid, scFramed(scSeg(scKCPCmdPush, 0, 2, 0, 10), scSeg(scKCPCmdPush, 1, 2, 0, 10)), 500, 0)
	send(872)
	scSizeCheckClient(cid, scSeg(scKCPCmdAck, 0, 0, sn, 0))
	if st.proven != 872 || st.ceil != 1052 {
		t.Fatalf("terbukti 872, berikut 1052: %+v", *st)
	}
	send(1052)
	scSizeExpire(st)
	plan := scSizeCaps(scSizeRec(cid, rrTypeNULL, 1232))
	if plan.probe != 0 || st.ceil != 872 || plan.base != 872 {
		t.Fatalf("selisih < %d harus berhenti di 872: %+v %+v", scSizeMinStep, plan, *st)
	}
	// Bukti terlambat untuk probe 1052 tetap diterima.
	scSizeCheckClient(cid, scSeg(scKCPCmdAck, 0, 0, sn, 0))
	if st.proven != 1052 {
		t.Fatalf("bukti terlambat harus menaikkan batas: %+v", *st)
	}
}

func TestSCSizePadFillsProbeExactly(t *testing.T) {
	scSizeReset(t)
	names := []dns.Name{
		{[]byte("t"), []byte("example"), []byte("com")},
		{bytes.Repeat([]byte("a"), 63), bytes.Repeat([]byte("b"), 63), []byte("t"), []byte("example"), []byte("com")},
	}
	for _, name := range names {
		for _, kind := range []uint16{dns.RRTypeTXT, rrTypeNULL} {
			for _, limit := range []int{600, 872, 1052, 1232} {
				resp := &dns.Message{
					ID: 1, Flags: 0x8400,
					Question:   []dns.Question{{Name: name, Type: kind, Class: dns.ClassIN}},
					Answer:     []dns.RR{{Name: name, Type: kind, Class: dns.ClassIN, TTL: responseTTL}},
					Additional: []dns.RR{{Type: dns.RRTypeOPT, Class: 4096}},
				}
				room := maxPayloadForResponse(resp, limit)
				var payload bytes.Buffer
				payload.Write(scFramed(scSeg(scKCPCmdPush, 1, 1, 0, 100)))
				scSizePad(&payload, room)
				if payload.Len() != room {
					t.Fatalf("padding %d byte, ruang %d", payload.Len(), room)
				}
				answers, err := dns.TunnelAnswers(resp.Question[0], responseTTL, payload.Bytes())
				if err != nil {
					t.Fatal(err)
				}
				resp.Answer = answers
				buf, err := scResponseWireFormat(resp)
				if err != nil || len(buf) > limit || len(buf) < limit-2 {
					t.Fatalf("respons probe %d byte untuk batas %d (%v)", len(buf), limit, err)
				}
				// Paket padding tidak berisi segmen PUSH (bukan data KCP).
				packets := payload.Bytes()[2+124:]
				if scKCPHasFreshPush(packets[2:], 0) {
					t.Fatal("padding terbaca sebagai data KCP")
				}
			}
		}
	}
}

// Probe dini (hemat RAM): respons pertama yang membawa data baru, walau kecil,
// sudah boleh jadi probe; ACK atau kiriman ulang saja tidak.
func TestSCPayloadHasFreshPush(t *testing.T) {
	if !scPayloadHasFreshPush(scFramed(scSeg(scKCPCmdAck, 0, 1, 0, 0), scSeg(scKCPCmdPush, 0, 1, 0, 48)), 0) {
		t.Fatal("balasan handshake (PUSH sn 0) harus bisa jadi probe")
	}
	if scPayloadHasFreshPush(scFramed(scSeg(scKCPCmdAck, 3, 1, 0, 0)), 0) {
		t.Fatal("respons ACK saja bukan probe")
	}
	if scPayloadHasFreshPush(scFramed(scSeg(scKCPCmdPush, 4, 1, 0, 10)), 5) {
		t.Fatal("kiriman ulang bukan probe")
	}
	if scPayloadHasFreshPush([]byte{0, 200, 1, 2}, 0) || scPayloadHasFreshPush(nil, 0) {
		t.Fatal("payload rusak bukan probe")
	}
}

func TestSCSizeParsersRejectMalformedPackets(t *testing.T) {
	scSizeReset(t)
	cid := scCid(7)
	st := scSizeFresh(cid)
	bad := scSeg(scKCPCmdPush, 1, 1, 0, 0)
	binary.LittleEndian.PutUint32(bad[20:], 0xffffffff)
	for _, p := range [][]byte{nil, {1, 2, 3}, bad, append(bad, 1, 2, 3)} {
		scKCPHasFreshPush(p, 0)
		scSizeCheckClient(cid, p)
		scSizeSent(cid, p, 1232, 1232)
		scSizeSent(cid, scFramed(p), 1232, 1232)
	}
	if st.proven != 512 {
		t.Fatalf("paket rusak tidak boleh membuktikan: %+v", *st)
	}
}

// Bukti menaikkan MTU sesi KCP sungguhan; respons yang tidak lebih besar dari
// batas terbukti tidak pernah dianggap probe.
func TestSCSizeProofRaisesSessionMTU(t *testing.T) {
	scSizeReset(t)
	cid := scCid(8)
	pconn := turbotunnel.NewQueuePacketConn(turbotunnel.DummyAddr{}, time.Minute)
	defer pconn.Close()
	sess, err := kcp.NewConn2(cid, nil, 0, 0, pconn)
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Close()
	sess.SetMtu(215)
	scSizeAttach(sess, 215)
	clientEdnsMu.Lock()
	st := clientSize[cid]
	clientEdnsMu.Unlock()
	if st == nil || st.sess != sess || st.proven != 512 {
		t.Fatalf("sesi tidak terpasang: %+v", st)
	}
	scSizeSent(cid, scFramed(scSeg(scKCPCmdPush, 0, 1, 0, 10)), 400, 0)
	if st.pendingSize != 0 {
		t.Fatal("respons <= batas terbukti bukan probe")
	}
	scSizeSent(cid, scFramed(scSeg(scKCPCmdPush, 1, 1, 0, 10)), 1200, 1232)
	scSizeCheckClient(cid, scSeg(scKCPCmdAck, 1, 1, 2, 0))
	if want := computeMaxEncodedPayload(1232) - 2; st.mtu != want {
		t.Fatalf("MTU sesi %d, mau %d", st.mtu, want)
	}
	clientEdnsForget(cid)
	clientEdnsMu.Lock()
	_, ok := clientSize[cid]
	clientEdnsMu.Unlock()
	if ok {
		t.Fatal("status ukuran harus dibuang saat sesi berakhir")
	}
}
