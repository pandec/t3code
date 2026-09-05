import { writeFileAtomically } from "../lib/atomic-file";

export interface ExpoJsonRowStorage<Row, LoadResult = ReadonlyArray<Row>> {
  readonly load: () => Promise<LoadResult>;
  readonly write: (row: Row) => Promise<void>;
  readonly remove: (row: Row) => Promise<void>;
}

export interface ExpoJsonRowLoadResult<Row, ReadError> {
  readonly rows: ReadonlyArray<Row>;
  readonly errors: ReadonlyArray<ReadError>;
}

export interface ExpoJsonRowStorageOptions<Row, ReadError = unknown> {
  readonly directoryName: string;
  readonly fileName: (row: Row) => string;
  readonly decode: (value: unknown) => Row;
  readonly encode: (row: Row) => unknown;
  readonly invalidRowWarning: string;
  readonly strictRows?: boolean;
  readonly loadError: (cause: unknown) => unknown;
  readonly readError: (fileName: string, cause: unknown) => ReadError;
  readonly writeError: (row: Row, fileName: string, cause: unknown) => unknown;
  readonly removeError: (row: Row, fileName: string, cause: unknown) => unknown;
}

interface ExpoJsonRowStore<Row, LoadResult> {
  readonly storage: ExpoJsonRowStorage<Row, LoadResult>;
  readonly flushWrites: () => Promise<void>;
}

export function createExpoJsonRowStorage<Row, ReadError>(
  options: ExpoJsonRowStorageOptions<Row, ReadError> & { readonly strictRows: true },
): ExpoJsonRowStore<Row, ExpoJsonRowLoadResult<Row, ReadError>>;
export function createExpoJsonRowStorage<Row>(
  options: ExpoJsonRowStorageOptions<Row> & { readonly strictRows?: false | undefined },
): ExpoJsonRowStore<Row, ReadonlyArray<Row>>;
/**
 * Tracks row writes so app-update restarts can wait for every atomic rename,
 * including writes that callers intentionally started without awaiting.
 */
export function createExpoJsonRowStorage<Row, ReadError>(
  options: ExpoJsonRowStorageOptions<Row, ReadError>,
): ExpoJsonRowStore<Row, ReadonlyArray<Row> | ExpoJsonRowLoadResult<Row, ReadError>> {
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
        const errors: ReadError[] = [];
        let File: typeof import("expo-file-system").File;
        let entries: ReturnType<Awaited<ReturnType<typeof getDirectory>>["list"]>;
        try {
          ({ File } = await import("expo-file-system"));
          entries = (await getDirectory()).list();
        } catch (cause) {
          throw options.loadError(cause);
        }
        for (const entry of entries) {
          if (!(entry instanceof File) || !entry.name.endsWith(".json")) continue;
          try {
            rows.push(options.decode(JSON.parse(await entry.text()) as unknown));
          } catch (cause) {
            const error = options.readError(entry.name, cause);
            if (options.strictRows === true) {
              errors.push(error);
            } else {
              console.warn(options.invalidRowWarning, error);
            }
          }
        }
        return options.strictRows === true ? { rows, errors } : rows;
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
