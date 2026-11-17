/** True inside the Tauri window; false in a plain browser (npm run dev:desktop). */
export const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
