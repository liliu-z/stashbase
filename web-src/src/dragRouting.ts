import { FILE_MIME, FOLDER_MIME } from './dragMime';

export interface DragPayloadKinds {
  osFiles: boolean;
  internalFile: boolean;
  internalFolder: boolean;
}

export function dragPayloadKinds(dt: DataTransfer): DragPayloadKinds {
  return {
    osFiles: dt.types.includes('Files'),
    internalFile: dt.types.includes(FILE_MIME),
    internalFolder: dt.types.includes(FOLDER_MIME),
  };
}

export function acceptsKnowledgeBaseDrop(dt: DataTransfer): boolean {
  const k = dragPayloadKinds(dt);
  return k.osFiles || k.internalFile || k.internalFolder;
}

export function acceptsAgentContextDrop(dt: DataTransfer): boolean {
  const k = dragPayloadKinds(dt);
  return k.osFiles || k.internalFile;
}
