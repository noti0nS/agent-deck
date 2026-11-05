package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"os"
	"strconv"
	"time"
)

const maxPayload = 60 * 1024

// The shim is an observer: never print a hook decision or fail the parent CLI.
func preparePayload(raw []byte, source, event string) []byte {
	if len(raw) == 0 || len(raw) > maxPayload || !json.Valid(raw) {
		return nil
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(raw, &payload) != nil || payload == nil {
		return nil
	}
	if source != "" {
		if source != "agy" && source != "claude" {
			return nil
		}
		payload["_agent_deck_source"], _ = json.Marshal(source)
		var eventID [16]byte
		if _, err := rand.Read(eventID[:]); err != nil {
			return nil
		}
		payload["event_id"], _ = json.Marshal(hex.EncodeToString(eventID[:]))
		payload["emitted_at_ms"], _ = json.Marshal(time.Now().UnixMilli())
	}
	if event != "" {
		if len(event) > 64 {
			return nil
		}
		payload["hook_event_name"], _ = json.Marshal(event)
	}
	encoded, err := json.Marshal(payload)
	if err != nil || len(encoded) > maxPayload {
		return nil
	}
	return encoded
}

func loopbackAddress(addr string) bool {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	n, err := strconv.Atoi(port)
	return ip != nil && ip.IsLoopback() && err == nil && n > 0 && n <= 65535
}

func sendPayload(input io.Reader, addr, source, event string) {
	buf, err := io.ReadAll(io.LimitReader(input, maxPayload+1))
	if err != nil {
		return
	}
	payload := preparePayload(buf, source, event)
	if payload == nil {
		return
	}
	// Reading stdin must not consume the UDP send budget. main still caps
	// the entire observation at 100ms so the parent agent never waits longer.
	conn, err := net.DialTimeout("udp", addr, 20*time.Millisecond)
	if err != nil {
		return
	}
	defer conn.Close()
	_ = conn.SetWriteDeadline(time.Now().Add(20 * time.Millisecond))
	_, _ = conn.Write(payload)
}

func main() {
	// Bound observation to 100ms. A 10ms budget dropped terminal events under
	// Windows scheduler load; telemetry still never blocks indefinitely or fails the CLI.
	done := make(chan struct{})
	go func() {
		defer close(done)
		addr := os.Getenv("AGENT_DECK_UDP_ADDR")
		if addr == "" {
			addr = "127.0.0.1:4101"
		}
		source, event := "", ""
		for i := 1; i < len(os.Args); i += 2 {
			if i+1 >= len(os.Args) {
				return
			}
			switch os.Args[i] {
			case "--source":
				source = os.Args[i+1]
			case "--event":
				event = os.Args[i+1]
			case "--udp-addr":
				addr = os.Args[i+1]
			default:
				return
			}
		}
		if !loopbackAddress(addr) {
			return
		}
		sendPayload(os.Stdin, addr, source, event)
	}()

	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
	}
	os.Exit(0)
}
