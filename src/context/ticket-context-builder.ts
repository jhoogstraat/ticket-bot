import type { NormalizedBugTicket } from "../domain/ticket.js";
export function buildTicketContext(ticket: NormalizedBugTicket): string {
  return JSON.stringify(ticket);
}
