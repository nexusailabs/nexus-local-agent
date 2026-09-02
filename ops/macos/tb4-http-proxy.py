#!/usr/bin/env python3
import select
import socket
import socketserver
import sys
from urllib.parse import urlsplit


def relay(left, right):
    sockets = [left, right]
    while sockets:
        readable, _, _ = select.select(sockets, [], [], 60)
        if not readable:
            break
        for source in readable:
            target = right if source is left else left
            data = source.recv(65536)
            if not data:
                return
            target.sendall(data)


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(30)
        buffer = b""
        while b"\r\n\r\n" not in buffer and len(buffer) < 131072:
            chunk = self.request.recv(65536)
            if not chunk:
                return
            buffer += chunk
        header_blob, body = buffer.split(b"\r\n\r\n", 1)
        lines = header_blob.split(b"\r\n")
        method, target, version = lines[0].decode("latin1").split(" ", 2)

        if method.upper() == "CONNECT":
            host, port = target.rsplit(":", 1)
            with socket.create_connection((host, int(port)), timeout=30) as upstream:
                self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                if body:
                    upstream.sendall(body)
                relay(self.request, upstream)
            return

        parsed = urlsplit(target)
        if parsed.scheme != "http" or not parsed.hostname:
            self.request.sendall(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            return

        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        headers = []
        for line in lines[1:]:
            name = line.split(b":", 1)[0].strip().lower()
            if name not in {b"proxy-connection", b"connection"}:
                headers.append(line)
        headers.append(b"Connection: close")
        outgoing = (
            f"{method} {path} {version}\r\n".encode("latin1")
            + b"\r\n".join(headers)
            + b"\r\n\r\n"
            + body
        )
        with socket.create_connection((parsed.hostname, parsed.port or 80), timeout=30) as upstream:
            upstream.sendall(outgoing)
            while True:
                chunk = upstream.recv(65536)
                if not chunk:
                    break
                self.request.sendall(chunk)


class ThreadingServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 256


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3128
    with ThreadingServer(("127.0.0.1", port), ProxyHandler) as server:
        server.serve_forever()
