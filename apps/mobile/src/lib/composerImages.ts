import {
  toUploadChatImageAttachments,
  type DraftComposerImageAttachment,
} from "@t3tools/client-runtime/state/composer-attachment";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { estimateBase64ByteSize } from "./base64";
import { uuidv4 } from "./uuid";

export { toUploadChatImageAttachments, type DraftComposerImageAttachment };

const OWNED_PASTED_IMAGE_DIRECTORY = "t3-composer-paste";

async function loadImagePicker() {
  try {
    return await import("expo-image-picker");
  } catch (error) {
    throw new Error("Image attachments are unavailable right now.", { cause: error });
  }
}

async function loadClipboard() {
  try {
    return await import("expo-clipboard");
  } catch (error) {
    throw new Error("Clipboard paste is unavailable right now.", { cause: error });
  }
}

const REENCODE_JPEG_QUALITY = 0.9;

/**
 * Re-encode an image as full-resolution JPEG. Screenshots come out of the
 * picker as multi-MB PNGs and the whole message travels in a single
 * WebSocket RPC frame, so payload size directly gates deliverability;
 * JPEG at 0.9 is visually lossless for screenshots while several times
 * smaller. The picker's own `quality` option can't do this: on iOS it
 * leaves PNG picks untouched, and on Android it re-encodes to JPEG while
 * keeping the original mime type on the asset. Sources that are already
 * JPEG are left alone (nothing to gain, avoids generation loss), and GIFs
 * are skipped because re-encoding would drop animation. Returns null when
 * re-encoding is skipped or unavailable (e.g. a binary that predates the
 * expo-image-manipulator dependency) — callers keep the original bytes.
 */
async function reencodeImageAsJpeg(input: {
  readonly uri: string;
  readonly mimeType: string;
}): Promise<{ readonly base64: string; readonly sizeBytes: number } | null> {
  if (input.mimeType === "image/jpeg" || input.mimeType === "image/gif") {
    return null;
  }
  try {
    const manipulator = await import("expo-image-manipulator");
    const result = await manipulator.manipulateAsync(input.uri, [], {
      base64: true,
      compress: REENCODE_JPEG_QUALITY,
      format: manipulator.SaveFormat.JPEG,
    });
    if (!result.base64) {
      return null;
    }
    return { base64: result.base64, sizeBytes: estimateBase64ByteSize(result.base64) };
  } catch {
    return null;
  }
}

function toJpegFileName(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, "");
  return `${base.length > 0 ? base : "image"}.jpg`;
}

// A second native launch while a picker is already presented orphans the visible
// picker's delegate (expo-image-picker keeps a single picking context), leaving it
// stuck on screen. Serialize launches across every composer surface.
let pickImagesInFlight = false;

export async function pickComposerImages(input: { readonly existingCount: number }): Promise<{
  readonly images: ReadonlyArray<DraftComposerImageAttachment>;
  readonly error: string | null;
}> {
  if (pickImagesInFlight) {
    return { images: [], error: null };
  }
  pickImagesInFlight = true;
  try {
    return await pickComposerImagesOnce(input);
  } finally {
    pickImagesInFlight = false;
  }
}

async function pickComposerImagesOnce(input: { readonly existingCount: number }): Promise<{
  readonly images: ReadonlyArray<DraftComposerImageAttachment>;
  readonly error: string | null;
}> {
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  if (remainingSlots <= 0) {
    return {
      images: [],
      error: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`,
    };
  }

  let imagePicker: Awaited<ReturnType<typeof loadImagePicker>>;
  try {
    imagePicker = await loadImagePicker();
  } catch (error) {
    return {
      images: [],
      error:
        error instanceof Error ? error.message : "Image attachments are unavailable right now.",
    };
  }

  let result: Awaited<ReturnType<typeof imagePicker.launchImageLibraryAsync>>;
  try {
    result = await imagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: remainingSlots,
      base64: true,
      // Keep the picker itself lossless; downsizing happens in
      // reencodeImageAsJpeg, which sets a matching mime type. Sub-1 quality
      // here would re-encode to JPEG on Android while the asset keeps its
      // original mime type, producing mislabeled data URLs.
      quality: 1,
    });
  } catch {
    return {
      images: [],
      error: "Could not open the photo library. Try again.",
    };
  }

  if (result.canceled) {
    return {
      images: [],
      error: null,
    };
  }

  const nextImages: DraftComposerImageAttachment[] = [];
  let error: string | null = null;

  for (const asset of result.assets) {
    const originalMimeType = asset.mimeType?.toLowerCase();
    if (!originalMimeType?.startsWith("image/")) {
      error = `Unsupported file type for '${asset.fileName ?? "image"}'.`;
      continue;
    }

    const originalBase64 = asset.base64;
    if (!originalBase64) {
      error = `Failed to read '${asset.fileName ?? "image"}'.`;
      continue;
    }

    const reencoded = await reencodeImageAsJpeg({ uri: asset.uri, mimeType: originalMimeType });
    const mimeType = reencoded ? "image/jpeg" : originalMimeType;
    const name = reencoded
      ? toJpegFileName(asset.fileName ?? "image")
      : (asset.fileName ?? "image");
    const base64 = reencoded ? reencoded.base64 : originalBase64;
    // Size the payload we actually ship; asset.fileSize describes the
    // original library file.
    const sizeBytes = reencoded ? reencoded.sizeBytes : estimateBase64ByteSize(originalBase64);
    if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      error = `'${asset.fileName ?? "image"}' exceeds the 10 MB attachment limit.`;
      continue;
    }

    nextImages.push({
      id: uuidv4(),
      type: "image",
      name,
      mimeType,
      sizeBytes,
      dataUrl: `data:${mimeType};base64,${base64}`,
      previewUri: asset.uri,
    });
  }

  return {
    images: nextImages,
    error,
  };
}

export async function pasteComposerClipboard(input: { readonly existingCount: number }): Promise<{
  readonly images: ReadonlyArray<DraftComposerImageAttachment>;
  readonly text: string | null;
  readonly error: string | null;
}> {
  let clipboard: Awaited<ReturnType<typeof loadClipboard>>;
  try {
    clipboard = await loadClipboard();
  } catch (error) {
    return {
      images: [],
      text: null,
      error: error instanceof Error ? error.message : "Clipboard paste is unavailable right now.",
    };
  }

  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;

  if (await clipboard.hasImageAsync()) {
    if (remainingSlots <= 0) {
      return {
        images: [],
        text: null,
        error: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`,
      };
    }
    const image = await clipboard.getImageAsync({ format: "png" });
    if (!image) {
      return {
        images: [],
        text: null,
        error: "Clipboard image is unavailable.",
      };
    }

    // Data URLs are accepted by the manipulator on iOS; where they aren't,
    // the helper falls back to the original PNG payload.
    const reencoded = await reencodeImageAsJpeg({ uri: image.data, mimeType: "image/png" });
    const dataUrl = reencoded ? `data:image/jpeg;base64,${reencoded.base64}` : image.data;
    const sizeBytes =
      reencoded?.sizeBytes ?? estimateBase64ByteSize(image.data.split(",")[1] ?? "");
    if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      return {
        images: [],
        text: null,
        error: "Clipboard image exceeds the 10 MB attachment limit.",
      };
    }

    return {
      images: [
        {
          id: uuidv4(),
          type: "image",
          name: reencoded ? "pasted-image.jpg" : "pasted-image.png",
          mimeType: reencoded ? "image/jpeg" : "image/png",
          sizeBytes,
          dataUrl,
          previewUri: dataUrl,
        },
      ],
      text: null,
      error: null,
    };
  }

  if (await clipboard.hasStringAsync()) {
    const text = await clipboard.getStringAsync();
    return {
      images: [],
      text: text.length > 0 ? text : null,
      error: text.length > 0 ? null : "Clipboard is empty.",
    };
  }

  return {
    images: [],
    text: null,
    error: "Clipboard does not contain pasteable text or image content.",
  };
}

function mimeTypeFromUri(uri: string): string {
  const ext = uri.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    default:
      return "image/png";
  }
}

export function isOwnedPastedImageUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") {
      return false;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      segments.at(-2) === OWNED_PASTED_IMAGE_DIRECTORY && segments.at(-1)?.endsWith(".png") === true
    );
  } catch {
    return false;
  }
}

export async function convertPastedImagesToAttachments(input: {
  readonly uris: ReadonlyArray<string>;
  readonly existingCount: number;
}): Promise<ReadonlyArray<DraftComposerImageAttachment>> {
  const { File } = await import("expo-file-system");
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  const results: DraftComposerImageAttachment[] = [];

  for (const [index, uri] of input.uris.entries()) {
    const ownedTemporaryFile = isOwnedPastedImageUri(uri);
    try {
      if (index >= Math.max(0, remainingSlots)) {
        continue;
      }
      const originalMimeType = mimeTypeFromUri(uri);
      const reencoded = await reencodeImageAsJpeg({ uri, mimeType: originalMimeType });
      const base64 = reencoded ? reencoded.base64 : await new File(uri).base64();
      const mimeType = reencoded ? "image/jpeg" : originalMimeType;
      const sizeBytes = reencoded ? reencoded.sizeBytes : estimateBase64ByteSize(base64);
      if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        continue;
      }
      results.push({
        id: uuidv4(),
        type: "image",
        name: `pasted-image.${mimeType.split("/")[1] ?? "png"}`,
        mimeType,
        sizeBytes,
        dataUrl: `data:${mimeType};base64,${base64}`,
        previewUri: ownedTemporaryFile ? `data:${mimeType};base64,${base64}` : uri,
      });
    } catch (error) {
      console.warn("Failed to read pasted image", uri, error);
    } finally {
      if (ownedTemporaryFile) {
        try {
          const file = new File(uri);
          if (file.exists) {
            file.delete();
          }
        } catch (error) {
          console.warn("Failed to remove temporary pasted image", uri, error);
        }
      }
    }
  }

  return results;
}
