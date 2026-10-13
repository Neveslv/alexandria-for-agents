"""Line-delimited MCP client with bounded reads/writes and forced cleanup."""
import json
import queue
import subprocess
import threading
import time

class RequestTimeout(TimeoutError):
    pass

class MCP:
    def __init__(self, command, env=None, log_path=None):
        self.log = open(log_path, "wb") if log_path else subprocess.DEVNULL
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.log, env=env)
        self.responses = queue.Queue()
        self.next_id = 0
        self.closed = False
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            for line in self.process.stdout:
                try:
                    self.responses.put(json.loads(line))
                except (ValueError, UnicodeError):
                    self.responses.put(RuntimeError("Non-JSON server stdout"))
        finally:
            self.responses.put(RuntimeError("MCP stdout closed"))

    def _write(self, message, deadline):
        done = queue.Queue()
        def write():
            try:
                self.process.stdin.write((json.dumps(message) + "\n").encode("utf-8"))
                self.process.stdin.flush()
                done.put(None)
            except (OSError, ValueError) as error:
                done.put(error)
        threading.Thread(target=write, daemon=True).start()
        try:
            error = done.get(timeout=max(0, deadline-time.monotonic()))
        except queue.Empty:
            self.close()
            raise RequestTimeout("MCP write timeout")
        if error:
            raise RuntimeError("MCP write failed") from error

    def call(self, method, params, timeout=30):
        if timeout <= 0 or self.closed:
            raise ValueError("Client closed or nonpositive timeout")
        started = time.monotonic()
        deadline = started + timeout
        self.next_id += 1
        request_id = self.next_id
        self._write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}, deadline)
        while True:
            if time.monotonic() >= deadline:
                self.close()
                raise RequestTimeout("MCP response timeout")
            try:
                reply = self.responses.get(timeout=max(0, deadline-time.monotonic()))
            except queue.Empty:
                self.close()
                raise RequestTimeout("MCP response timeout")
            if isinstance(reply, Exception):
                raise reply
            if reply.get("id") != request_id:
                continue
            if "error" in reply or reply.get("result", {}).get("isError"):
                raise RuntimeError("MCP request returned error")
            return reply, (time.monotonic()-started)*1000

    def initialize(self, timeout=30):
        result = self.call("initialize", {"protocolVersion":"2024-11-05",
            "capabilities":{}, "clientInfo":{"name":"synthetic-retrieval-eval","version":"1"}}, timeout)
        self._write({"jsonrpc":"2.0","method":"notifications/initialized"}, time.monotonic()+timeout)
        return result

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=1)
        for stream in (self.process.stdin, self.process.stdout):
            try:
                stream.close()
            except (OSError, ValueError):
                pass
        if self.log != subprocess.DEVNULL:
            self.log.close()
