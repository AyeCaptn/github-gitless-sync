import { diff3Merge } from "node-diff3";

interface ConflictMetadata {
  sha: string | null;
  deleted?: boolean | null;
  deletedAt?: number | null;
  lastModified?: number;
}

export type DeletionSyncAction =
  | "upload"
  | "download"
  | "delete_local"
  | "delete_remote";

/**
 * A text conflict requires two different edits from the same synced base.
 * Deletions are handled as sync actions because the text editor cannot load
 * content for a side that no longer exists.
 */
export function isContentConflict(
  remoteFile: ConflictMetadata,
  localFile: ConflictMetadata,
  actualLocalSha: string | null,
): boolean {
  if (remoteFile.deleted || localFile.deleted || actualLocalSha === null) {
    return false;
  }

  return (
    remoteFile.sha !== localFile.sha &&
    actualLocalSha !== localFile.sha &&
    remoteFile.sha !== actualLocalSha
  );
}

/**
 * Propagates a deletion when the other side still matches the synced base.
 * For a true delete/modify race, it falls back to the plugin's existing
 * last-write-wins policy. Returning null means neither side is deleted.
 */
export function getDeletionSyncAction(
  remoteFile: ConflictMetadata,
  localFile: ConflictMetadata,
  actualLocalSha: string | null,
): DeletionSyncAction | null {
  if (remoteFile.deleted && localFile.deleted) {
    return null;
  }

  if (remoteFile.deleted) {
    if (actualLocalSha === null || actualLocalSha === localFile.sha) {
      return "delete_local";
    }
    if (
      remoteFile.deletedAt !== null &&
      remoteFile.deletedAt !== undefined &&
      localFile.lastModified !== undefined &&
      localFile.lastModified > remoteFile.deletedAt
    ) {
      return "upload";
    }
    return "delete_local";
  }

  if (localFile.deleted) {
    if (remoteFile.sha === localFile.sha) {
      return "delete_remote";
    }
    if (
      localFile.deletedAt !== null &&
      localFile.deletedAt !== undefined &&
      remoteFile.lastModified !== undefined &&
      remoteFile.lastModified > localFile.deletedAt
    ) {
      return "download";
    }
    return "delete_remote";
  }

  return null;
}

/**
 * Merges independent local and remote edits using their last synced content.
 * Returns null when both sides changed overlapping lines.
 */
export function tryThreeWayMerge(
  localContent: string,
  baseContent: string,
  remoteContent: string,
): string | null {
  const regions = diff3Merge(
    localContent.split("\n"),
    baseContent.split("\n"),
    remoteContent.split("\n"),
    { excludeFalseConflicts: true },
  );

  if (regions.some((region) => region.conflict !== undefined)) {
    return null;
  }

  const mergedLines: string[] = [];
  regions.forEach((region) => {
    if (region.ok !== undefined) {
      mergedLines.push(...region.ok);
    }
  });
  return mergedLines.join("\n");
}
