// @vayo/ui — the live Socket.IO connection, shared the same way ConfigContext
// shares the API config. `null` is a legitimate value (not yet authenticated,
// or the caller never provided a socketUrl), unlike config which is always
// present once the app renders past the login gate — so this doesn't throw.
import { createContext, useContext, type ReactNode } from "react";
import type { Socket } from "socket.io-client";

const SocketContext = createContext<Socket | null>(null);

export function SocketProvider({ socket, children }: { socket: Socket | null; children: ReactNode }): JSX.Element {
  return <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>;
}

export function useSocket(): Socket | null {
  return useContext(SocketContext);
}
