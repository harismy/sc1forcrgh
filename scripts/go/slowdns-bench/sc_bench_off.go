//go:build !scbench

package main

import (
	"github.com/xtaci/kcp-go/v5"
	"www.bamsoftware.com/git/dnstt.git/turbotunnel"
)

func scBenchTune(*kcp.UDPSession)               {}
func scBenchSetTT(*turbotunnel.QueuePacketConn) {}
