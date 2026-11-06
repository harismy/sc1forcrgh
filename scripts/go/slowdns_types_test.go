package main

import (
	"bytes"
	"encoding/base32"
	"testing"
	"www.bamsoftware.com/git/dnstt.git/dns"
)

func TestSCRecordTypeBufferGuards(t *testing.T) {
	domain, _ := dns.ParseName("test.example")
	raw := []byte("testcid1")
	prefix := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)
	name, _ := dns.ParseName(prefix + ".test.example")
	for _, kind := range []uint16{1, 2, 5, 10, 15, 16, 28, 33} {
		for _, size := range []uint16{512, 1232, 4096} {
			q := dns.Message{Question: []dns.Question{{Name: name, Type: kind, Class: dns.ClassIN}},
				Additional: []dns.RR{{Type: dns.RRTypeOPT, Class: size}}}
			response, payload := responseFor(&q, domain)
			if kind == 1 && size < 1232 {
				if response.Rcode() != dns.RcodeFormatError || len(payload) != 0 {
					t.Fatal("A accepted undersized buffer")
				}
			} else if response.Rcode() != 0 || !bytes.Equal(payload, raw) {
				t.Fatal(kind, size, response.Rcode())
			}
		}
	}
	// A restrictive server-wide MTU must fail clearly rather than truncate every segment.
	saved := maxUDPPayload
	defer func() { maxUDPPayload = saved }()
	maxUDPPayload = 700
	q := dns.Message{Question: []dns.Question{{Name: name, Type: 1, Class: dns.ClassIN}}, Additional: []dns.RR{{Type: dns.RRTypeOPT, Class: 4096}}}
	response, _ := responseFor(&q, domain)
	if response.Rcode() != dns.RcodeFormatError {
		t.Fatal("ignored server MTU cap")
	}
	// Normal resolver minimization/glue probes do not contain a tunnel ClientID.
	q.Question[0].Name = domain
	q.Additional[0].Class = 512
	response, _ = responseFor(&q, domain)
	if response.Rcode() == dns.RcodeFormatError {
		t.Fatal("buffer guard affected non-tunnel A query")
	}
}
