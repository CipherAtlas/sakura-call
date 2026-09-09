import type { CaptionEvent } from "../components/SubtitlesPanel";

export type CaptionPipMessage = {
  id: string;
  isLocal: boolean;
  originalText: string;
  speakerName: string;
  timestamp: number;
  translatedText: string;
};
type DocumentPictureInPictureOptions = {
  disallowReturnToOpener?: boolean;
  height?: number;
  width?: number;
};
type DocumentPictureInPictureController = {
  requestWindow: (
    options?: DocumentPictureInPictureOptions,
  ) => Promise<Window>;
  window?: Window | null;
};
export type WindowWithDocumentPictureInPicture = Window & {
  documentPictureInPicture?: DocumentPictureInPictureController;
};
export type VideoPictureInPictureElement = HTMLVideoElement & {
  requestPictureInPicture?: () => Promise<unknown>;
  webkitPresentationMode?: "fullscreen" | "inline" | "picture-in-picture";
  webkitSetPresentationMode?: (
    mode: "fullscreen" | "inline" | "picture-in-picture",
  ) => void;
};
export type DocumentWithVideoPictureInPicture = Document & {
  exitPictureInPicture?: () => Promise<void>;
  pictureInPictureElement?: Element | null;
  pictureInPictureEnabled?: boolean;
};
export type CaptionVideoPipController = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  stream: MediaStream;
  video: VideoPictureInPictureElement;
};
function formatCaptionPipTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function captionPipMessageId(caption: CaptionEvent, isLocal: boolean) {
  return `${isLocal ? "local" : "remote"}-${caption.timestamp}-${caption.speakerId}`;
}

export function appendCaptionPipMessage(
  messages: CaptionPipMessage[],
  caption: CaptionEvent | null,
  isLocal: boolean,
  speakerName: string,
) {
  if (!caption) {
    return messages;
  }

  const id = captionPipMessageId(caption, isLocal);

  if (messages.some((message) => message.id === id)) {
    return messages;
  }

  return [
    ...messages,
    {
      id,
      isLocal,
      originalText: caption.originalText,
      speakerName,
      timestamp: caption.timestamp,
      translatedText: caption.translatedText,
    },
  ];
}

function wrapCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const nextLine = line ? `${line} ${word}` : word;

    if (context.measureText(nextLine).width <= maxWidth || !line) {
      line = nextLine;
      continue;
    }

    lines.push(line);
    line = word;
  }

  if (line) {
    lines.push(line);
  }

  return lines;
}

function drawRoundedRectangle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);

  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - safeRadius,
    y + height,
  );
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

export function drawCaptionVideoPipCanvas({
  emptyText,
  messages,
  title,
  videoPip,
}: {
  emptyText: string;
  messages: CaptionPipMessage[];
  title: string;
  videoPip: CaptionVideoPipController;
}) {
  const { canvas, context } = videoPip;
  const width = canvas.width;
  const height = canvas.height;
  const padding = 42;

  context.clearRect(0, 0, width, height);
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#2d1b2b");
  gradient.addColorStop(0.62, "#211620");
  gradient.addColorStop(1, "#3a2133");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  context.fillStyle = "rgba(255, 141, 183, 0.16)";
  context.beginPath();
  context.arc(width * 0.18, height * 0.18, 148, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "rgba(215, 183, 255, 0.12)";
  context.beginPath();
  context.arc(width * 0.86, height * 0.1, 132, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#fff1f6";
  context.font = "900 34px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  context.textBaseline = "top";
  context.fillText(title, padding, padding);

  const latestMessages = messages.slice(-4);

  if (latestMessages.length === 0) {
    context.fillStyle = "#efbfd1";
    context.font = "900 30px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    context.textAlign = "center";
    const lines = wrapCanvasText(context, emptyText, width - padding * 2);
    const startY = height / 2 - (lines.length * 40) / 2;
    lines.forEach((line, index) => {
      context.fillText(line, width / 2, startY + index * 40);
    });
    context.textAlign = "left";
    return;
  }

  let y = padding + 74;
  const cardGap = 16;
  const cardWidth = width - padding * 2;

  for (const message of latestMessages) {
    context.font = "900 22px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    const textLines = wrapCanvasText(
      context,
      message.translatedText || message.originalText,
      cardWidth - 40,
    ).slice(0, 3);
    const cardHeight = 70 + textLines.length * 31;

    context.fillStyle = message.isLocal
      ? "rgba(66, 51, 88, 0.82)"
      : "rgba(62, 42, 58, 0.82)";
    context.strokeStyle = message.isLocal
      ? "rgba(215, 183, 255, 0.34)"
      : "rgba(255, 141, 183, 0.26)";
    context.lineWidth = 2;
    drawRoundedRectangle(context, padding, y, cardWidth, cardHeight, 18);
    context.fill();
    context.stroke();

    context.fillStyle = "#efbfd1";
    context.font = "900 18px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    context.fillText(message.speakerName, padding + 20, y + 18);

    context.fillStyle = "#fff8fb";
    context.font = "900 25px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    textLines.forEach((line, index) => {
      context.fillText(line, padding + 20, y + 48 + index * 31);
    });

    y += cardHeight + cardGap;
  }
}

export function renderCaptionPipWindow({
  emptyText,
  messages,
  pipWindow,
  title,
}: {
  emptyText: string;
  messages: CaptionPipMessage[];
  pipWindow: Window;
  title: string;
}) {
  const pipDocument = pipWindow.document;
  pipDocument.title = title;

  let style = pipDocument.getElementById("sakura-caption-pip-style");

  if (!style) {
    style = pipDocument.createElement("style");
    style.id = "sakura-caption-pip-style";
    style.textContent = `
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        background:
          radial-gradient(circle at 18% 12%, rgba(255, 196, 215, 0.28), transparent 9rem),
          linear-gradient(180deg, rgba(255, 252, 254, 0.98), rgba(255, 246, 250, 0.94));
        color: #432536;
        margin: 0;
        min-height: 100vh;
      }
      .caption-pip {
        box-sizing: border-box;
        display: grid;
        gap: 0.75rem;
        grid-template-rows: auto minmax(0, 1fr);
        min-height: 100vh;
        padding: 0.9rem;
      }
      .caption-pip h1 {
        align-items: center;
        color: #7b3154;
        display: flex;
        font-size: 0.95rem;
        font-weight: 950;
        gap: 0.45rem;
        line-height: 1;
        margin: 0;
      }
      .caption-pip-list {
        align-content: end;
        display: grid;
        gap: 0.55rem;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
      }
      .caption-pip-message {
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid rgba(217, 93, 138, 0.16);
        border-radius: 0.58rem;
        box-shadow: 0 10px 24px rgba(126, 57, 82, 0.08);
        display: grid;
        gap: 0.3rem;
        padding: 0.7rem;
      }
      .caption-pip-message.is-local {
        background: rgba(246, 235, 255, 0.72);
        border-color: rgba(181, 139, 234, 0.24);
      }
      .caption-pip-meta {
        align-items: center;
        color: #7b5266;
        display: flex;
        font-size: 0.68rem;
        font-weight: 900;
        gap: 0.5rem;
        justify-content: space-between;
        line-height: 1.1;
      }
      .caption-pip-text {
        color: #3f2333;
        font-size: 0.98rem;
        font-weight: 950;
        line-height: 1.22;
        margin: 0;
      }
      .caption-pip-original {
        color: #7b5266;
        font-size: 0.76rem;
        font-weight: 800;
        line-height: 1.25;
        margin: 0;
      }
      .caption-pip-empty {
        align-self: center;
        color: #8c6174;
        font-size: 0.9rem;
        font-weight: 900;
        line-height: 1.3;
        margin: 0;
        text-align: center;
      }
      @media (prefers-color-scheme: dark) {
        body {
          background:
            radial-gradient(circle at 16% 14%, rgba(143, 61, 104, 0.28), transparent 9rem),
            linear-gradient(180deg, rgba(34, 24, 34, 0.98), rgba(26, 20, 28, 0.96));
          color: #fff1f6;
        }
        .caption-pip h1 {
          color: #ffe1ec;
        }
        .caption-pip-message {
          background: rgba(62, 42, 58, 0.78);
          border-color: rgba(255, 141, 183, 0.18);
          box-shadow: 0 12px 28px rgba(0, 0, 0, 0.22);
        }
        .caption-pip-message.is-local {
          background: rgba(66, 51, 88, 0.72);
          border-color: rgba(215, 183, 255, 0.22);
        }
        .caption-pip-meta,
        .caption-pip-original,
        .caption-pip-empty {
          color: #efbfd1;
        }
        .caption-pip-text {
          color: #fff8fb;
        }
      }
    `;
    pipDocument.head.append(style);
  }

  const root = pipDocument.createElement("main");
  root.className = "caption-pip";

  const heading = pipDocument.createElement("h1");
  heading.textContent = title;
  root.append(heading);

  const list = pipDocument.createElement("section");
  list.className = "caption-pip-list";
  list.setAttribute("aria-live", "polite");

  if (messages.length === 0) {
    const empty = pipDocument.createElement("p");
    empty.className = "caption-pip-empty";
    empty.textContent = emptyText;
    list.append(empty);
  } else {
    for (const message of messages) {
      const article = pipDocument.createElement("article");
      article.className = `caption-pip-message ${
        message.isLocal ? "is-local" : "is-remote"
      }`;

      const meta = pipDocument.createElement("div");
      meta.className = "caption-pip-meta";
      const speaker = pipDocument.createElement("span");
      speaker.textContent = message.speakerName;
      const time = pipDocument.createElement("time");
      time.dateTime = new Date(message.timestamp).toISOString();
      time.textContent = formatCaptionPipTime(message.timestamp);
      meta.append(speaker, time);

      const translated = pipDocument.createElement("p");
      translated.className = "caption-pip-text";
      translated.textContent = message.translatedText;

      article.append(meta, translated);

      if (message.originalText && message.originalText !== message.translatedText) {
        const original = pipDocument.createElement("p");
        original.className = "caption-pip-original";
        original.textContent = message.originalText;
        article.append(original);
      }

      list.append(article);
    }
  }

  root.append(list);
  pipDocument.body.replaceChildren(root);
  list.scrollTop = list.scrollHeight;
}

