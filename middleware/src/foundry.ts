import { io } from "socket.io-client";

export interface FoundryAccount {
  id: string;
  name: string;
  role: number;
}

export interface FoundryInventory {
  worldId: string;
  accounts: FoundryAccount[];
}

export async function discoverFoundryAccounts(): Promise<FoundryInventory> {
  // Fixed Docker service address: never accept a caller-supplied destination.
  const response = await fetch("http://foundry:30000/join", {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 200) throw new Error("Foundry join initialization failed");
  const cookies = response.headers.getSetCookie().map(value => value.split(";")[0]);
  if (cookies.length === 0) throw new Error("Foundry did not issue a session cookie");
  const socket = io("http://foundry:30000", {
    transports: ["websocket"],
    reconnection: false,
    autoConnect: false,
    timeout: 5000,
    // New, unauthenticated Foundry HTTP session. Never reuse a browser cookie.
    extraHeaders: { Cookie: cookies.join("; ") },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Foundry connection timed out")), 6000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("connect_error", (error) => { clearTimeout(timer); reject(error); });
      socket.connect();
    });
    const response: unknown = await socket.timeout(5000).emitWithAck("getJoinData");
    if (!response || typeof response !== "object") throw new Error("Invalid Foundry join data");
    const data = response as Record<string, unknown>;
    const world = data.world;
    if (!world || typeof world !== "object" ||
        typeof (world as Record<string, unknown>).id !== "string" ||
        !(world as { id: string }).id) throw new Error("No active Foundry world");
    if (!Array.isArray(data.users)) throw new Error("Invalid Foundry account inventory");
    const accounts = data.users.map((item: unknown) => {
      if (!item || typeof item !== "object") throw new Error("Invalid Foundry account");
      const user = item as Record<string, unknown>;
      if (typeof user._id !== "string" || !user._id ||
          typeof user.name !== "string" || !user.name ||
          !Number.isInteger(user.role) || (user.role as number) < 0 || (user.role as number) > 4) {
        throw new Error("Invalid Foundry account");
      }
      return { id: user._id, name: user.name, role: user.role as number };
    });
    return { worldId: (world as { id: string }).id, accounts };
  } finally {
    socket.disconnect();
  }
}
