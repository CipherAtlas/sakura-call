import { CallRoom } from "@/components/CallRoom";

export default async function RoomPage({
  params
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;

  return <CallRoom roomId={roomId} />;
}
