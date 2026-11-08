package main

import (
	"log"
	"os"
	"strconv"
	"strings"
)

// Pengaturan KCP dari environment (sc-fast8). Default sama persis dengan
// sc-fast7: interval 10 ms dan ACK tidak dikirim langsung. Nilai kosong atau
// rusak selalu kembali ke default supaya salah ketik tidak memperlambat tunnel.
const (
	scKCPIntervalDefault = 10
	scKCPIntervalMin     = 10
	scKCPIntervalMax     = 50
)

type scKCPTuning struct {
	interval   int
	ackNoDelay bool
}

// scParseKCPInterval menerima milidetik bulat 10..50. ok=false berarti ditolak.
func scParseKCPInterval(raw string) (int, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return scKCPIntervalDefault, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < scKCPIntervalMin || n > scKCPIntervalMax {
		return scKCPIntervalDefault, false
	}
	return n, true
}

// scParseKCPAckNoDelay: 1/true/yes/on menyalakan; 0/false/no/off/kosong mematikan.
func scParseKCPAckNoDelay(raw string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "0", "false", "no", "off":
		return false, true
	case "1", "true", "yes", "on":
		return true, true
	}
	return false, false
}

// scLoadKCPTuning dipanggil sekali saat acceptSessions mulai; semua sesi memakai
// nilai yang sama sampai service di-restart.
func scLoadKCPTuning() scKCPTuning {
	var t scKCPTuning
	var ok bool
	raw := os.Getenv("SLOWDNS_KCP_INTERVAL")
	if t.interval, ok = scParseKCPInterval(raw); !ok {
		log.Printf("SLOWDNS_KCP_INTERVAL=%q tidak valid (%d..%d); memakai %d ms",
			raw, scKCPIntervalMin, scKCPIntervalMax, scKCPIntervalDefault)
	}
	raw = os.Getenv("SLOWDNS_KCP_ACK_NODELAY")
	if t.ackNoDelay, ok = scParseKCPAckNoDelay(raw); !ok {
		log.Printf("SLOWDNS_KCP_ACK_NODELAY=%q tidak valid (0/1); ACK langsung mati", raw)
	}
	log.Printf("KCP interval %d ms ack-nodelay %t window %d", t.interval, t.ackNoDelay, kcpWindow())
	return t
}
