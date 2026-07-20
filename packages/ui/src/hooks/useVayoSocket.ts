// @vayo/ui — Socket.IO client wrapper (docs/06-realtime-collaboration.md).
// One connection per session; reconnects handled by socket.io-client itself.

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";

export function useVayoSocket(socketUrl: string, token: string | null, path = "/socket.io"): Socket | null {
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    if (!token) {
      setSocket(null);
      return;
    }
    const instance = io(socketUrl, { path, auth: { token } });
    setSocket(instance);
    return () => {
      instance.disconnect();
    };
  }, [socketUrl, token, path]);

  return socket;
}
