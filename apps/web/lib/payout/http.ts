import { railFailure } from "./explain";
import type { RailResult } from "./index";

/** A rail result as 1Click answers: 200 with the body, or 400/404 with `{ message }` (SPEC §8.11). */
export function railResponse<T>(result: RailResult<T>): Response {
  if (result.ok) return Response.json(result.value);
  const status = result.refusal === "unknown-quote" ? 404 : 400;
  return Response.json(
    { mock: true, message: railFailure(result.refusal).sentence, reason: result.refusal },
    { status },
  );
}

export async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function badRequest(message: string): Response {
  return Response.json({ mock: true, message }, { status: 400 });
}
