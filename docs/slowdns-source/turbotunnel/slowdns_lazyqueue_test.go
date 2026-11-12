package turbotunnel

import (
	"runtime"
	"testing"
	"time"
)

// sc-fast9: antrean kirim malas. Salin ke paket turbotunnel.

func lazyCid(n int) ClientID {
	var c ClientID
	c[0], c[1], c[2], c[3] = byte(n>>24), byte(n>>16), byte(n>>8), byte(n)
	return c
}

func TestSCPeekDoesNotAllocateSendQueue(t *testing.T) {
	c := NewQueuePacketConn(DummyAddr{}, time.Minute)
	defer c.Close()
	stash, send, wake := c.PeekQueues(lazyCid(1))
	if stash == nil || wake == nil {
		t.Fatal("stash dan wake wajib ada")
	}
	if send != nil {
		t.Fatal("Peek tidak boleh membuat antrean kirim")
	}
	// OutgoingQueue (dipakai dnstt-client) tetap selalu membuat antrean.
	q := c.OutgoingQueue(lazyCid(2))
	if q == nil || cap(q) != QueueSize {
		t.Fatalf("OutgoingQueue harus membuat antrean QueueSize, dapat cap %d", cap(q))
	}
}

func TestSCWriteToWakesWaiter(t *testing.T) {
	c := NewQueuePacketConn(DummyAddr{}, time.Minute)
	defer c.Close()
	addr := lazyCid(3)
	got := make(chan []byte, 1)
	go func() {
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		for {
			unstash, outgoing, wake := c.PeekQueues(addr)
			select {
			case p := <-unstash:
				got <- p
				return
			case p := <-outgoing:
				got <- p
				return
			case <-wake:
				continue
			case <-timer.C:
				got <- nil
				return
			}
		}
	}()
	time.Sleep(50 * time.Millisecond)
	start := time.Now()
	if _, err := c.WriteTo([]byte("halo"), addr); err != nil {
		t.Fatal(err)
	}
	p := <-got
	if string(p) != "halo" {
		t.Fatalf("penunggu harus menerima paket pertama, dapat %q", p)
	}
	if d := time.Since(start); d > 500*time.Millisecond {
		t.Fatalf("paket pertama terlambat %v (wake tidak bekerja)", d)
	}
	_, send, _ := c.PeekQueues(addr)
	if send == nil {
		t.Fatal("setelah WriteTo, Peek harus mengembalikan antrean kirim")
	}
}

func TestSCExpireLightRecordDoesNotPanic(t *testing.T) {
	m := NewRemoteMap(0)
	m.Peek(lazyCid(4))
	m.SendQueue(lazyCid(5))
	m.lock.Lock()
	m.inner.removeExpired(time.Now().Add(time.Hour), time.Minute)
	n := len(m.inner.byAge)
	m.lock.Unlock()
	if n != 0 {
		t.Fatalf("semua record harus kedaluwarsa, sisa %d", n)
	}
}

// Banjir ClientID sampah: tiap record ringan jauh di bawah 196 KB antrean penuh.
func TestSCPeekMemoryPerClient(t *testing.T) {
	c := NewQueuePacketConn(DummyAddr{}, time.Minute)
	defer c.Close()
	const n = 5000
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	for i := 0; i < n; i++ {
		c.PeekQueues(lazyCid(100 + i))
	}
	runtime.ReadMemStats(&after)
	per := (after.TotalAlloc - before.TotalAlloc) / n
	if per > 2048 {
		t.Fatalf("Peek per ClientID mengalokasikan %d byte; batas 2048 (antrean penuh = %d)", per, QueueSize*24)
	}
	t.Logf("alokasi per ClientID sampah: %d byte", per)
}
