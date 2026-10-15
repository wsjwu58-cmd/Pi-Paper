import { create } from "zustand";
import type { PointAccount, UserPreference, UserView } from "./types";
import { api, setTokens } from "./api";

interface AuthState {
  user: UserView | null;
  account: PointAccount | null;
  preferences: UserPreference | null;
  ready: boolean;
  load: () => Promise<void>;
  login: (account: string, password: string) => Promise<void>;
  register: (email: string, password: string, nickname: string, inviteCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshAccount: () => Promise<void>;
  updatePreferences: (p: Partial<UserPreference>) => Promise<void>;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  account: null,
  preferences: null,
  ready: false,

  async load() {
    try {
      const me = await api<{ user: UserView; account: PointAccount; preferences: UserPreference }>("/me");
      set({ user: me.user, account: me.account, preferences: me.preferences, ready: true });
    } catch {
      set({ user: null, account: null, preferences: null, ready: true });
    }
  },

  async login(account: string, password: string) {
    const t = await api<import("./types").TokenResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ account, password }),
    });
    setTokens(t);
    await get().load();
  },

  async register(email: string, password: string, nickname: string, inviteCode?: string) {
    const t = await api<import("./types").TokenResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, nickname, inviteCode }),
    });
    setTokens(t);
    await get().load();
  },

  async logout() {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    setTokens(null);
    set({ user: null, account: null, preferences: null });
  },

  async refreshAccount() {
    try {
      const account = await api<PointAccount>("/accounts/me");
      set({ account });
    } catch {
      /* ignore */
    }
  },

  async updatePreferences(p: Partial<UserPreference>) {
    const preferences = await api<UserPreference>("/me/preferences", {
      method: "PUT",
      body: JSON.stringify(p),
    });
    set({ preferences });
  },
}));
