package main

import (
	"io"
	"net"
	"os"
	"time"
)

func main() {
	// Hard 10ms fail-open deadline (§5.3, §9): never block or fail the CLI
	done := make(chan struct{})
	go func() {
		defer close(done)
		addr := os.Getenv("AGENT_DECK_UDP_ADDR")
		if addr == "" {
			addr = "127.0.0.1:4101"
		}
		conn, err := net.DialTimeout("udp", addr, 5*time.Millisecond)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Millisecond))

		buf, err := io.ReadAll(io.LimitReader(os.Stdin, 32*1024))
		if err != nil || len(buf) == 0 {
			return
		}
		_, _ = conn.Write(buf)
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Millisecond):
	}
	os.Exit(0)
}
