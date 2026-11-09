package main

// Prototipe UJI: buang retransmisi KCP yang salinan aslinya masih menunggu di
// antrean keluar dnstt (belum terkirim lewat jawaban DNS). Aktif hanya kalau
// SC_BENCH_DEDUP=1 (build uji, bukan installer).
//
// Hasil V.1FSC.126 (docs/slowdns-cpu-research-v126.md): GAGAL. CPU per MiB
// turun di sebagian profil, tetapi ping saat download naik dan download
// paralel turun. kcp-go tetap memperbarui ts segmen yang retransmisinya
// dibuang di sini, sehingga fast-ack untuk segmen itu tidak jalan dan loss
// sungguhan baru pulih lewat RTO. Jangan dipindah ke patch installer.

import (
	"encoding/binary"
	"net"
	"os"
	"sync"
	"sync/atomic"

	"www.bamsoftware.com/git/dnstt.git/turbotunnel"
)

const (
	scKCPOverhead = 24
	scKCPCmdPush  = 81
)

type scDedupConn struct {
	*turbotunnel.QueuePacketConn
	mu      sync.Mutex
	queued  map[turbotunnel.ClientID]map[uint64]int32
	dropped atomic.Uint64 // segmen PUSH yang dibuang karena aslinya masih antre
}

var scDedup *scDedupConn

func scDedupEnabled() bool { return os.Getenv("SC_BENCH_DEDUP") == "1" }

func newSCDedupConn(c *turbotunnel.QueuePacketConn) *scDedupConn {
	d := &scDedupConn{QueuePacketConn: c, queued: make(map[turbotunnel.ClientID]map[uint64]int32)}
	scDedup = d
	return d
}

// scKCPPushKeys memanggil fn untuk tiap segmen PUSH (conv<<32|sn) di paket p.
// Mengembalikan false kalau paket tidak berbentuk deretan segmen KCP utuh.
func scKCPWalk(p []byte, fn func(off, end int, push bool, key uint64)) bool {
	off := 0
	for off < len(p) {
		if len(p)-off < scKCPOverhead {
			return false
		}
		n := int(binary.LittleEndian.Uint32(p[off+20:]))
		end := off + scKCPOverhead + n
		if n < 0 || end > len(p) || end < off {
			return false
		}
		conv := binary.LittleEndian.Uint32(p[off:])
		sn := binary.LittleEndian.Uint32(p[off+12:])
		fn(off, end, p[off+4] == scKCPCmdPush, uint64(conv)<<32|uint64(sn))
		off = end
	}
	return true
}

func (d *scDedupConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	cid, ok := addr.(turbotunnel.ClientID)
	if !ok {
		return d.QueuePacketConn.WriteTo(p, addr)
	}
	q := d.QueuePacketConn.OutgoingQueue(addr)
	d.mu.Lock()
	m := d.queued[cid]
	if m == nil {
		m = make(map[uint64]int32)
		d.queued[cid] = m
	}
	// Tandai segmen yang masih antre; kalau ada, susun paket baru tanpanya.
	var dup int
	if !scKCPWalk(p, func(_, _ int, push bool, key uint64) {
		if push && m[key] > 0 {
			dup++
		}
	}) {
		d.mu.Unlock()
		return d.QueuePacketConn.WriteTo(p, addr)
	}
	out := p
	if dup > 0 {
		out = make([]byte, 0, len(p))
		scKCPWalk(p, func(off, end int, push bool, key uint64) {
			if !(push && m[key] > 0) {
				out = append(out, p[off:end]...)
			}
		})
		d.dropped.Add(uint64(dup))
	}
	if len(out) == 0 || len(q) >= cap(q) {
		// Semua isinya sudah antre, atau antrean penuh (WriteTo asli juga membuang).
		d.mu.Unlock()
		return len(p), nil
	}
	scKCPWalk(out, func(_, _ int, push bool, key uint64) {
		if push {
			m[key]++
		}
	})
	d.mu.Unlock()
	return d.QueuePacketConn.WriteTo(out, addr)
}

// scDedupSent dipanggil sendLoop saat paket p keluar dari antrean (dikirim
// atau dibuang), sehingga retransmisi berikutnya boleh antre lagi.
func scDedupSent(cid turbotunnel.ClientID, p []byte) {
	d := scDedup
	if d == nil {
		return
	}
	d.mu.Lock()
	if m := d.queued[cid]; m != nil {
		scKCPWalk(p, func(_, _ int, push bool, key uint64) {
			if push {
				if m[key] <= 1 {
					delete(m, key)
				} else {
					m[key]--
				}
			}
		})
	}
	d.mu.Unlock()
}

func scDedupForget(cid turbotunnel.ClientID) {
	if d := scDedup; d != nil {
		d.mu.Lock()
		delete(d.queued, cid)
		d.mu.Unlock()
	}
}
