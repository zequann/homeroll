import type { DemoAccount } from "@/lib/wallet/adapter";

/**
 * Which pages each demo wallet uses. Connected, a wallet sees only its own pages; with no wallet
 * every page stays open, so a first visitor can look around and connect from any of them.
 */
export type Role = DemoAccount["role"];
export type Surface = "owner" | "lab" | "worker" | "lender";

const SURFACES: Record<Role, readonly Surface[]> = {
  Owner: ["owner", "lab"],
  Worker: ["worker"],
  Lender: ["lender"],
};
const EVERY: readonly Surface[] = ["owner", "worker", "lab", "lender"];

export const SURFACE_PATH: Record<Surface, string> = {
  owner: "/owner",
  lab: "/lab",
  worker: "/worker",
  lender: "/lender",
};

export function surfacesFor(role: Role | null): readonly Surface[] {
  return role ? SURFACES[role] : EVERY;
}

/** Where a wallet lands: its first page. */
export function homeFor(role: Role): string {
  return SURFACE_PATH[SURFACES[role][0] ?? "owner"];
}

/** The surface a path belongs to, or null for pages every wallet may open (the landing page). */
export function surfaceOf(pathname: string): Surface | null {
  for (const surface of EVERY) {
    const path = SURFACE_PATH[surface];
    if (pathname === path || pathname.startsWith(`${path}/`)) return surface;
  }
  return null;
}

export function mayOpen(pathname: string, role: Role | null): boolean {
  const surface = surfaceOf(pathname);
  return surface === null || surfacesFor(role).includes(surface);
}
