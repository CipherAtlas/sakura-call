const screenAudioBitrate = 192_000;
const voiceAudioBitrate = 96_000;

function mediaSections(sdp: string) {
  return sdp.split(/(?=^m=)/m);
}

function mid(section: string) {
  return section.match(/^a=mid:(.+)\r?$/m)?.[1].trim();
}

// Opus receive preferences must be advertised in both offers and answers.
// Our microphone is mono; sprop-stereo identifies the remote stereo source
// even when its screen-started notification has not arrived yet.
export function configureCallAudioDescription(
  description: RTCSessionDescriptionInit,
  localScreenStreamId?: string,
  remoteDescription?: RTCSessionDescriptionInit | null,
): RTCSessionDescriptionInit {
  if (!description.sdp) return description;

  const remoteStereoMids = new Set(
    mediaSections(remoteDescription?.sdp ?? "")
      .filter(section => section.startsWith("m=audio ") &&
        /^a=fmtp:\d+ .*\bsprop-stereo=1(?:;|\s|$)/m.test(section))
      .map(mid)
      .filter((value): value is string => value !== undefined),
  );

  const sdp = mediaSections(description.sdp).map(section => {
    if (!section.startsWith("m=audio ") || /^m=audio 0 /m.test(section) ||
      /^a=inactive\r?$/m.test(section)) return section;

    const isLocalScreen = Boolean(localScreenStreamId) &&
      [...section.matchAll(/^a=msid:(\S+) /gm)]
        .some(match => match[1] === localScreenStreamId);
    const isScreen = isLocalScreen || remoteStereoMids.has(mid(section) ?? "");

    const payload = section.match(/^a=rtpmap:(\d+) opus\/48000\/2\r?$/im)?.[1];
    if (!payload) return section;

    const newline = section.includes("\r\n") ? "\r\n" : "\n";
    const lines = section.split(/\r?\n/);
    const prefix = `a=fmtp:${payload} `;
    const index = lines.findIndex(line => line.startsWith(prefix));
    const parameters = new Map<string, string>();
    for (const entry of (index < 0 ? "" : lines[index].slice(prefix.length)).split(";")) {
      const separator = entry.indexOf("=");
      if (separator >= 0) {
        parameters.set(entry.slice(0, separator).trim(), entry.slice(separator + 1).trim());
      }
    }
    parameters.set("stereo", isScreen ? "1" : "0");
    parameters.set("maxaveragebitrate", String(isScreen ? screenAudioBitrate : voiceAudioBitrate));
    parameters.set("maxplaybackrate", "48000");
    parameters.set("usedtx", "0");
    if (isLocalScreen) parameters.set("sprop-stereo", "1");

    const fmtp = prefix + [...parameters].map(([key, value]) => `${key}=${value}`).join(";");
    if (index >= 0) lines[index] = fmtp;
    else lines.splice(lines.findIndex(line => line.startsWith(`a=rtpmap:${payload} `)) + 1, 0, fmtp);

    return lines.join(newline);
  }).join("");

  return { type: description.type, sdp };
}
