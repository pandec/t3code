import { writeFileAtomically } from "../lib/atomic-file";

export interface ExpoJsonRowStorage<Row> {
  readonly load: () => Promise<ReadonlyArray<Row>>;
  readonly write: (row: Row) => Promise<void>;
  readonly remove: (row: Row) => Promise<void>;
}

export interface ExpoJsonRowStorageOptions<Row> {
  readonly directoryName: string;
  readonly fileName: (row: Row) => string;
  readonly decode: (value: unknown) => Row;
  readonly encode: (row: Row) => unknown;
  readonly invalidRowWarning: string;
  readonly loadError: (cause: unknown) => unknown;
  readonly readError: (fileName: string, cause: unknown) => unknown;
  readonly writeError: (row: Row, fileName: string, cause: unknown) => unknown;
  readonly removeError: (row: Row, fileName: string, cause: unknown) => unknown;
}

export function createExpoJsonRowStorage<Row>(options: ExpoJsonRowStorageOptions<Row>): {
  readonly storage: ExpoJsonRowStorage<Row>;
  readonly flushWrites: () => Promise<void>;
} {
  const inFlightWrites = new Set<Promise<void>>();

  const trackWrite = (operation: Promise<void>): Promise<void> => {
    inFlightWrites.add(operation);
    void operation.catch(() => undefined).finally(() => inFlightWrites.delete(operation));
    return operation;
  };

  const flushWrites = async (): Promise<void> => {
    while (inFlightWrites.size > 0) await Promise.allSettled(inFlightWrites);
  };

  const getDirectory = async () => {
    const { Directory, Paths } = await import("expo-file-system");
    const directory = new Directory(Paths.document, options.directoryName);
    directory.create({ idempotent: true, intermediates: true });
    return directory;
  };

  const getFile = async (fileName: string) => {
    const { File } = await import("expo-file-system");
    return new File(await getDirectory(), fileName);
  };

  return {
    flushWrites,
    storage: {
      load: async () => {
        const rows: Row[] = [];
        try {
          const { File } = await import("expo-file-system");
          const directory = await getDirectory();
          for (const entry of directory.list()) {
            if (!(entry instanceof File) || !entry.name.endsWith(".json")) continue;
            try {
              rows.push(options.decode(JSON.parse(await entry.text()) as unknown));
            } catch (cause) {
              console.warn(options.invalidRowWarning, options.readError(entry.name, cause));
            }
          }
        } catch (cause) {
          throw options.loadError(cause);
        }
        return rows;
      },
      write: async (row) => {
        const fileName = options.fileName(row);
        try {
          await trackWrite(
            (async () => {
              const file = await getFile(fileName);
              await writeFileAtomically(file, JSON.stringify(options.encode(row)));
            })(),
          );
        } catch (cause) {
          throw options.writeError(row, fileName, cause);
        }
      },
      remove: async (row) => {
        const fileName = options.fileName(row);
        try {
          const file = await getFile(fileName);
          if (file.exists) file.delete();
        } catch (cause) {
          throw options.removeError(row, fileName, cause);
        }
      },
    },
  };
}
