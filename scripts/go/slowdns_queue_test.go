package main

import (
	"flag"
	"strings"
	"testing"
)

// sc-fast14 (V.1FSC.139): kapasitas antrean jawaban lewat -record-queue.
// Tanpa flag = 512, nilai di luar 100..8192 dijepit, dan run() memakai nilai
// itu sebagai kapasitas kanal record (terlihat di laporan "kapasitas N").

func TestSCClampRecordQueue(t *testing.T) {
	for _, c := range []struct{ in, want int }{
		{0, scRecordQueueDefault},
		{-5, scRecordQueueDefault},
		{1, scRecordQueueMin},
		{99, scRecordQueueMin},
		{100, 100},
		{512, 512},
		{1024, 1024},
		{2048, 2048},
		{8192, 8192},
		{8193, scRecordQueueMax},
		{1 << 30, scRecordQueueMax},
	} {
		if got := scClampRecordQueue(c.in); got != c.want {
			t.Errorf("scClampRecordQueue(%d) = %d, mau %d", c.in, got, c.want)
		}
	}
	if scRecordQueueDefault != 512 || scRecordQueueMin != 100 || scRecordQueueMax != 8192 {
		t.Fatal("batas antrean berubah; samakan dengan record_queue() di installer")
	}
}

func TestSCRecordQueueCapUsesFlag(t *testing.T) {
	old := scRecordQueueFlag
	defer func() { scRecordQueueFlag = old }()
	scRecordQueueFlag = 0
	if got := scRecordQueueCap(); got != scRecordQueueDefault {
		t.Fatalf("tanpa flag = %d, mau %d", got, scRecordQueueDefault)
	}
	scRecordQueueFlag = 1024
	if got := scRecordQueueCap(); got != 1024 {
		t.Fatalf("flag 1024 = %d", got)
	}
	scRecordQueueFlag = 50000
	if got := scRecordQueueCap(); got != scRecordQueueMax {
		t.Fatalf("flag kebesaran = %d, mau %d", got, scRecordQueueMax)
	}
}

// Helper installer mendeteksi dukungan lewat teks -h ("-record-queue").
func TestSCQueueFlagRegistered(t *testing.T) {
	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	old := flag.CommandLine
	flag.CommandLine = fs
	defer func() { flag.CommandLine = old }()
	scQueueFlags()
	f := fs.Lookup("record-queue")
	if f == nil {
		t.Fatal("flag -record-queue tidak terdaftar")
	}
	if !strings.Contains(f.Usage, "100..8192") {
		t.Fatalf("usage: %q", f.Usage)
	}
	if err := fs.Parse([]string{"-record-queue", "2048"}); err != nil || scRecordQueueFlag != 2048 {
		t.Fatalf("parse: err=%v nilai=%d", err, scRecordQueueFlag)
	}
	scRecordQueueFlag = 0
}
