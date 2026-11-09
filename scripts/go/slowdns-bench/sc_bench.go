//go:build scbench

// Instrumen KHUSUS build uji lokal (tag scbench). Tidak pernah masuk installer.
// SC_BENCH_ADDR=127.0.0.1:PORT membuka HTTP lokal:
//
//	/snmp        -> kcp.DefaultSnmp + kedalaman antrean keluar + srtt/rto sesi
//	/prof/start  -> runtime/pprof CPU profile ke ?path=
//	/prof/stop
//
// SC_BENCH_NODELAY / SC_BENCH_RESEND / SC_BENCH_NC / SC_BENCH_SNDWND /
// SC_BENCH_RCVWND menimpa setelan KCP per sesi (kosong = tidak diubah).
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"runtime/pprof"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/xtaci/kcp-go/v5"
	"www.bamsoftware.com/git/dnstt.git/turbotunnel"
)

var (
	scBenchMu       sync.Mutex
	scBenchSessions = map[uint32]*kcp.UDPSession{}
	scBenchTT       atomic.Pointer[turbotunnel.QueuePacketConn]
	scBenchQSum     atomic.Int64 // jumlah paket di antrean keluar, dijumlah per sampel
	scBenchQN       atomic.Int64 // banyak sampel
	scBenchQMax     atomic.Int64 // maksimum sejak dibaca terakhir
	scBenchProf     *os.File
)

func scBenchEnvInt(k string) int {
	v, err := strconv.Atoi(os.Getenv(k))
	if err != nil {
		return -1
	}
	return v
}

func scBenchTune(conn *kcp.UDPSession) {
	nd, rs, nc := scBenchEnvInt("SC_BENCH_NODELAY"), scBenchEnvInt("SC_BENCH_RESEND"), scBenchEnvInt("SC_BENCH_NC")
	if nd >= 0 || rs >= 0 || nc >= 0 {
		conn.SetNoDelay(nd, -1, rs, nc)
	}
	snd, rcv := scBenchEnvInt("SC_BENCH_SNDWND"), scBenchEnvInt("SC_BENCH_RCVWND")
	if snd > 0 || rcv > 0 {
		conn.SetWindowSize(snd, rcv)
	}
	log.Printf("SCBENCH session %08x nodelay %d resend %d nc %d sndwnd %d rcvwnd %d", conn.GetConv(), nd, rs, nc, snd, rcv)
	scBenchMu.Lock()
	scBenchSessions[conn.GetConv()] = conn
	scBenchMu.Unlock()
}

func scBenchSetTT(c *turbotunnel.QueuePacketConn) { scBenchTT.Store(c) }

func scBenchSample() {
	tt := scBenchTT.Load()
	if tt == nil {
		return
	}
	scBenchMu.Lock()
	var total int64
	for _, s := range scBenchSessions {
		if cid, ok := s.RemoteAddr().(turbotunnel.ClientID); ok {
			total += int64(len(tt.OutgoingQueue(cid)))
		}
	}
	scBenchMu.Unlock()
	scBenchQSum.Add(total)
	scBenchQN.Add(1)
	for {
		m := scBenchQMax.Load()
		if total <= m || scBenchQMax.CompareAndSwap(m, total) {
			break
		}
	}
}

func init() {
	addr := os.Getenv("SC_BENCH_ADDR")
	if addr == "" {
		return
	}
	go func() {
		t := time.NewTicker(20 * time.Millisecond)
		for range t.C {
			scBenchSample()
		}
	}()
	mux := http.NewServeMux()
	mux.HandleFunc("/snmp", func(w http.ResponseWriter, r *http.Request) {
		type sess struct {
			Conv         uint32
			SRTT, RTTVar int32
			RTO          uint32
		}
		var dd uint64
		if scDedup != nil {
			dd = scDedup.dropped.Load()
		}
		out := struct {
			Snmp     *kcp.Snmp
			QSum     int64
			QN       int64
			QMax     int64
			Sessions []sess
			Dedup    uint64
		}{Dedup: dd, Snmp: kcp.DefaultSnmp.Copy(), QSum: scBenchQSum.Load(), QN: scBenchQN.Load(), QMax: scBenchQMax.Swap(0)}
		scBenchMu.Lock()
		for c, s := range scBenchSessions {
			out.Sessions = append(out.Sessions, sess{c, s.GetSRTT(), s.GetSRTTVar(), s.GetRTO()})
		}
		scBenchMu.Unlock()
		json.NewEncoder(w).Encode(out)
	})
	mux.HandleFunc("/prof/start", func(w http.ResponseWriter, r *http.Request) {
		f, err := os.Create(r.URL.Query().Get("path"))
		if err == nil {
			err = pprof.StartCPUProfile(f)
		}
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		scBenchProf = f
	})
	mux.HandleFunc("/prof/stop", func(w http.ResponseWriter, r *http.Request) {
		pprof.StopCPUProfile()
		if scBenchProf != nil {
			scBenchProf.Close()
			scBenchProf = nil
		}
	})
	go func() { log.Printf("SCBENCH http: %v", http.ListenAndServe(addr, mux)) }()
}
