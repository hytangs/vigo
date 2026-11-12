// Compiler steps run in a separate `vigo` process and may hold a store's write
// lock briefly while Studio reads it. Readers wait for that lock to clear
// instead of failing with "database is locked".
export const readerBusyTimeoutMs = 5_000
