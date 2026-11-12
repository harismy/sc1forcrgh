package main

import (
	"errors"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"www.bamsoftware.com/git/dnstt.git/turbotunnel"
)

// Buffer terima socket UDP DNS (sc-fast9). Bawaan Linux ~208 KB meluap saat
// lonjakan query (id3: 3,8 juta paket dibuang dalam 3 jam). 2 MiB diminta dan
// kernel menggandakannya jadi 4 MiB selama net.core.rmem_max mengizinkan
// (installer menaikkannya ke >= 4 MiB). SLOWDNS_UDP_RCVBUF=0 = bawaan OS.
const (
	scUDPRcvbufDefault = 2 << 20
	scUDPRcvbufMin     = 64 << 10
	scUDPRcvbufMax     = 32 << 20
)

func scParseUDPRcvbuf(raw string) (int, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return scUDPRcvbufDefault, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 || n > scUDPRcvbufMax || (n > 0 && n < scUDPRcvbufMin) {
		return scUDPRcvbufDefault, false
	}
	return n, true
}

func scSetUDPReadBuffer(c net.PacketConn) {
	raw := os.Getenv("SLOWDNS_UDP_RCVBUF")
	size, ok := scParseUDPRcvbuf(raw)
	if !ok {
		log.Printf("SLOWDNS_UDP_RCVBUF=%q tidak valid (0 atau %d..%d byte); memakai %d",
			raw, scUDPRcvbufMin, scUDPRcvbufMax, size)
	}
	if size == 0 {
		return
	}
	s, ok := c.(interface{ SetReadBuffer(int) error })
	if !ok {
		return
	}
	if err := s.SetReadBuffer(size); err != nil {
		log.Printf("UDP receive buffer %d byte gagal: %v", size, err)
		return
	}
	log.Printf("UDP receive buffer diminta %d byte (dibatasi net.core.rmem_max)", size)
}

// Penjaga banjir sesi palsu (sc-fast9).
const (
	scHandshakeTimeoutDefault = 30 * time.Second
	scHandshakeTimeoutMin     = 3 * time.Second
	scHandshakeTimeoutMax     = 300 * time.Second
	// Entri EDNS ClientID yang tidak bertanya selama ini boleh dibuang saat map
	// penuh. Klien hidup bertanya paling lambat tiap ~10 detik.
	scEdnsTTL = int64(idleTimeout / time.Second)
	// Sapuan map paling sering sekali per sekian detik.
	scEdnsSweepEvery = 10
)

var (
	// scHandshakeTimeout dihitung sejak sesi KCP dibuat. Klien asli mengirim
	// pesan handshake di paket pertamanya, jadi 30 detik sangat longgar.
	scHandshakeTimeout    = scHandshakeTimeoutDefault
	errSCHandshakeTimeout = errors.New("handshake Noise tidak selesai sebelum tenggat")
	scHandshakeTimeouts   uint64
	// clientSeen: waktu terakhir (detik Unix) tiap ClientID di clientEdns
	// bertanya. Dijaga clientEdnsMu, kuncinya selalu sama dengan clientEdns.
	clientSeen      = make(map[turbotunnel.ClientID]int64)
	scEdnsLastSweep int64
)

// scParseHandshakeTimeout menerima detik bulat 3..300; kosong = default.
func scParseHandshakeTimeout(raw string) (time.Duration, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return scHandshakeTimeoutDefault, true
	}
	n, err := strconv.Atoi(raw)
	d := time.Duration(n) * time.Second
	if err != nil || d < scHandshakeTimeoutMin || d > scHandshakeTimeoutMax {
		return scHandshakeTimeoutDefault, false
	}
	return d, true
}

// scLoadSessionGuard dipanggil sekali saat acceptSessions mulai.
func scLoadSessionGuard() {
	raw := os.Getenv("SLOWDNS_HANDSHAKE_TIMEOUT")
	d, ok := scParseHandshakeTimeout(raw)
	if !ok {
		log.Printf("SLOWDNS_HANDSHAKE_TIMEOUT=%q tidak valid (3..300 detik); memakai %d", raw, int(d/time.Second))
	}
	scHandshakeTimeout = d
	log.Printf("handshake timeout %d s", int(d/time.Second))
	go scHandshakeReport()
}

// scHandshakeError mengganti error handshake yang terjadi setelah tenggat
// dengan errSCHandshakeTimeout (tidak dilog per sesi, hanya dihitung).
func scHandshakeError(err error, deadline time.Time) error {
	if err != nil && !time.Now().Before(deadline) {
		atomic.AddUint64(&scHandshakeTimeouts, 1)
		return errSCHandshakeTimeout
	}
	return err
}

// scHandshakeReport menulis satu baris per menit selama ada sesi yang ditutup
// karena handshake tidak selesai, supaya banjir sesi palsu terlihat di journal.
func scHandshakeReport() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for range t.C {
		if n := atomic.SwapUint64(&scHandshakeTimeouts, 0); n > 0 {
			log.Printf("handshake timeout: %d sesi tanpa handshake ditutup dalam 1 menit terakhir", n)
		}
	}
}

// scEdnsSweepIfFull dipanggil dengan clientEdnsMu terkunci sebelum entri
// dicatat. Kalau map penuh dan cid belum ada, entri yang tidak bertanya selama
// scEdnsTTL dibuang (paling sering sekali per scEdnsSweepEvery detik).
func scEdnsSweepIfFull(cid turbotunnel.ClientID) {
	if _, ok := clientEdns[cid]; ok || len(clientEdns) < clientEdnsMax {
		return
	}
	now := time.Now().Unix()
	if now-scEdnsLastSweep < scEdnsSweepEvery {
		return
	}
	scEdnsLastSweep = now
	for k, seen := range clientSeen {
		if now-seen >= scEdnsTTL {
			delete(clientEdns, k)
			delete(clientKinds, k)
			delete(clientSeen, k)
		}
	}
}

// scEdnsMarkSeen dipanggil dengan clientEdnsMu terkunci setelah entri dicatat.
func scEdnsMarkSeen(cid turbotunnel.ClientID) {
	if _, ok := clientEdns[cid]; ok {
		clientSeen[cid] = time.Now().Unix()
	}
}
