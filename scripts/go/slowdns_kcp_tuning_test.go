package main

import "testing"

// sc-fast8: SLOWDNS_KCP_INTERVAL dan SLOWDNS_KCP_ACK_NODELAY. Default wajib sama
// dengan sc-fast7 (10 ms, ACK biasa), dan nilai rusak tidak boleh lolos.
func TestSCKCPIntervalParse(t *testing.T) {
	cases := []struct {
		raw  string
		want int
		ok   bool
	}{
		{"", 10, true}, {"10", 10, true}, {"20", 20, true}, {" 20 ", 20, true},
		{"50", 50, true}, {"010", 10, true},
		{"9", 10, false}, {"0", 10, false}, {"51", 10, false}, {"5000", 10, false},
		{"-20", 10, false}, {"20ms", 10, false}, {"1e3", 10, false}, {"abc", 10, false},
		{"20.5", 10, false}, {"99999999999999999999", 10, false},
	}
	for _, c := range cases {
		got, ok := scParseKCPInterval(c.raw)
		if got != c.want || ok != c.ok {
			t.Errorf("interval %q = %d,%v; want %d,%v", c.raw, got, ok, c.want, c.ok)
		}
	}
}

func TestSCKCPAckNoDelayParse(t *testing.T) {
	cases := []struct {
		raw  string
		want bool
		ok   bool
	}{
		{"", false, true}, {"0", false, true}, {"false", false, true}, {"NO", false, true}, {"off", false, true},
		{"1", true, true}, {"true", true, true}, {" Yes ", true, true}, {"ON", true, true},
		{"2", false, false}, {"maybe", false, false}, {"-1", false, false},
	}
	for _, c := range cases {
		got, ok := scParseKCPAckNoDelay(c.raw)
		if got != c.want || ok != c.ok {
			t.Errorf("ack %q = %v,%v; want %v,%v", c.raw, got, ok, c.want, c.ok)
		}
	}
}

func TestSCKCPTuningFromEnv(t *testing.T) {
	cases := []struct {
		interval, ack string
		want          scKCPTuning
	}{
		{"", "", scKCPTuning{10, false}},
		{"20", "0", scKCPTuning{20, false}},
		{"10", "1", scKCPTuning{10, true}},
		{"20", "1", scKCPTuning{20, true}},
		{"7", "ya", scKCPTuning{10, false}},
	}
	for _, c := range cases {
		t.Setenv("SLOWDNS_KCP_INTERVAL", c.interval)
		t.Setenv("SLOWDNS_KCP_ACK_NODELAY", c.ack)
		if got := scLoadKCPTuning(); got != c.want {
			t.Errorf("env %q/%q = %+v; want %+v", c.interval, c.ack, got, c.want)
		}
	}
}
