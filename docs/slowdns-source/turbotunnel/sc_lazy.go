package turbotunnel

import (
	"net"
	"time"
)

// Antrean kirim malas (SC sc-fast9). Record dibuat ringan oleh Lookup; antrean
// QueueSize slot baru dialokasikan saat ada paket untuk addr (SendQueue/WriteTo),
// supaya ClientID dari query sampah tidak memakan ~196 KB masing-masing.

// ensureSendQueue dipanggil dengan RemoteMap.lock terpegang.
func (record *remoteRecord) ensureSendQueue() chan []byte {
	if record.SendQueue == nil {
		record.SendQueue = make(chan []byte, QueueSize)
		select {
		case record.Wake <- struct{}{}:
		default:
		}
	}
	return record.SendQueue
}

// Peek mengembalikan stash, antrean kirim (nil kalau belum pernah ada paket
// untuk addr), dan kanal wake, tanpa membuat antrean kirim. LastSeen diperbarui
// seperti Lookup biasa.
func (m *RemoteMap) Peek(addr net.Addr) (<-chan []byte, <-chan []byte, <-chan struct{}) {
	m.lock.Lock()
	defer m.lock.Unlock()
	record := m.inner.Lookup(addr, time.Now())
	return record.Stash, record.SendQueue, record.Wake
}

// PeekQueues: lihat RemoteMap.Peek. OutgoingQueue tetap selalu membuat antrean.
func (c *QueuePacketConn) PeekQueues(addr net.Addr) (<-chan []byte, <-chan []byte, <-chan struct{}) {
	return c.remotes.Peek(addr)
}
