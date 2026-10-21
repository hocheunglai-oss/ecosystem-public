export type DropEdge = "before" | "after";

/** Convert a visible insertion boundary to the index after removing the source. */
export function dropDestination(from: number, target: number, edge: DropEdge): number {
  const boundary = target + (edge === "after" ? 1 : 0);
  return boundary - (from < boundary ? 1 : 0);
}

export function dropEdge(position: number, start: number, size: number): DropEdge {
  return position < start + size / 2 ? "before" : "after";
}
