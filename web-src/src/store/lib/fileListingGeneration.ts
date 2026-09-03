/** Global renderer ownership for file-listing requests. Every new request
 * invalidates all older success, failure, and post-listing continuations. */
export interface FileListingOwnership {
  isCurrent: () => boolean;
}

export function createFileListingGeneration() {
  let latest = 0;
  return {
    begin(ownsContext: () => boolean = () => true): FileListingOwnership {
      const generation = ++latest;
      return { isCurrent: () => generation === latest && ownsContext() };
    },
  };
}
