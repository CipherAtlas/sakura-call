const publicInviteBaseUrl =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://call.sabarg.com";

export function buildInviteUrl(roomId: string) {
  return `${publicInviteBaseUrl.replace(/\/$/, "")}/room/${roomId}`;
}
