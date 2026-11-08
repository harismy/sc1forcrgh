package main

import (
    "bytes"
    "encoding/binary"

    "www.bamsoftware.com/git/dnstt.git/dns"
)

// Hitung overhead hanya untuk bentuk respons yang dibangun responseFor.
// Nama question pertama belum terkompresi; answer menunjuk ke offset 12.
// Root memakai satu byte nol, termasuk OPT. Tidak ada cache global/buffer pool.
func scResponseOverhead(resp *dns.Message) (int, bool) {
    if len(resp.Question) != 1 || len(resp.Answer) != 1 ||
        len(resp.Authority) != 0 || len(resp.Additional) > 1 {
        return 0, false
    }
    q, a := &resp.Question[0], &resp.Answer[0]
    if (a.Type != dns.RRTypeTXT && a.Type != rrTypeNULL) ||
        q.Type != a.Type || len(q.Name) != len(a.Name) {
        return 0, false
    }
    nameLen := 1
    for i, label := range q.Name {
        if len(label) == 0 || len(label) > 63 || !bytes.Equal(label, a.Name[i]) {
            return 0, false
        }
        nameLen += 1 + len(label)
    }
    if nameLen > 255 {
        return 0, false
    }
    answerNameLen := 2
    if len(q.Name) == 0 {
        answerNameLen = 1
    }
    overhead := 12 + nameLen + 4 + answerNameLen + 10
    if len(resp.Additional) == 1 {
        opt := &resp.Additional[0]
        if opt.Type != dns.RRTypeOPT || len(opt.Name) != 0 || len(opt.Data) > 65535 {
            return 0, false
        }
        overhead += 11 + len(opt.Data)
    }
    return overhead, true
}

func scAppend16(buf []byte, value uint16) []byte {
    return append(buf, byte(value >> 8), byte(value))
}

func scAppendRRBody(buf []byte, rr *dns.RR) []byte {
    buf = scAppend16(buf, rr.Type)
    buf = scAppend16(buf, rr.Class)
    buf = append(buf, byte(rr.TTL >> 24), byte(rr.TTL >> 16), byte(rr.TTL >> 8), byte(rr.TTL))
    buf = scAppend16(buf, uint16(len(rr.Data)))
    return append(buf, rr.Data...)
}

// Satu alokasi dengan ukuran tepat; kepemilikan buffer tetap per respons.
// Seluruh bentuk lain dan error integer overflow memakai implementasi upstream.
func scResponseWireFormat(resp *dns.Message) ([]byte, error) {
    overhead, ok := scResponseOverhead(resp)
    if !ok || len(resp.Answer[0].Data) > 65535 {
        return resp.WireFormat()
    }
    q, a := &resp.Question[0], &resp.Answer[0]
    buf := make([]byte, 12, overhead + len(a.Data))
    binary.BigEndian.PutUint16(buf[0:2], resp.ID)
    binary.BigEndian.PutUint16(buf[2:4], resp.Flags)
    binary.BigEndian.PutUint16(buf[4:6], 1)
    binary.BigEndian.PutUint16(buf[6:8], 1)
    binary.BigEndian.PutUint16(buf[10:12], uint16(len(resp.Additional)))
    for _, label := range q.Name {
        buf = append(buf, byte(len(label)))
        buf = append(buf, label...)
    }
    buf = append(buf, 0)
    buf = scAppend16(buf, q.Type)
    buf = scAppend16(buf, q.Class)
    if len(q.Name) == 0 {
        buf = append(buf, 0)
    } else {
        buf = append(buf, 0xc0, 0x0c)
    }
    buf = scAppendRRBody(buf, a)
    if len(resp.Additional) == 1 {
        buf = append(buf, 0)
        buf = scAppendRRBody(buf, &resp.Additional[0])
    }
    return buf, nil
}
