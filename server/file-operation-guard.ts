import { cancelConversionAndWait } from './conversion.ts';
import { toSourcePath } from './folder.ts';

/** File ownership operations cancel queued/running source and preview work,
 * then wait for native processes to release the source before disk mutation. */
export function prepareFileOperation(name: string): Promise<boolean> {
  return cancelConversionAndWait(toSourcePath(name), 'file-operation');
}
