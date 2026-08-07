// IndexedDB 图片缓存,用于预设卡片的背景图。

const CACHE_DB_NAME = 'PresetCardsCache';
const CACHE_STORE_NAME = 'images';
let cacheDb: IDBDatabase | null = null;

function initCacheDb(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
        if (cacheDb) return resolve(cacheDb);
        const request = indexedDB.open(CACHE_DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = (e.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
                db.createObjectStore(CACHE_STORE_NAME);
            }
        };
        request.onsuccess = (e) => {
            cacheDb = (e.target as IDBOpenDBRequest).result;
            resolve(cacheDb);
        };
        request.onerror = () => {
            console.warn('preset-cards: Failed to open IndexedDB for caching.');
            resolve(null);
        };
    });
}

export async function getCachedImageURL(url: string): Promise<string> {
    if (!url) return '';
    // Skip data URIs or local blob URIs
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;

    const db = await initCacheDb();
    if (!db) return url;

    return new Promise<string>((resolve) => {
        const tx = db.transaction(CACHE_STORE_NAME, 'readonly');
        const store = tx.objectStore(CACHE_STORE_NAME);
        const req = store.get(url);

        req.onsuccess = async () => {
            if (req.result) {
                resolve(URL.createObjectURL(req.result as Blob));
            } else {
                try {
                    const response = await fetch(url, { mode: 'cors' });
                    if (!response.ok) throw new Error('Network response was not ok');
                    const blob = await response.blob();

                    const writeTx = db.transaction(CACHE_STORE_NAME, 'readwrite');
                    writeTx.objectStore(CACHE_STORE_NAME).put(blob, url);

                    resolve(URL.createObjectURL(blob));
                } catch (err) {
                    console.warn('preset-cards: CORS or network error caching image, falling back to original URL.', err);
                    resolve(url);
                }
            }
        };
        req.onerror = () => resolve(url);
    });
}

export function applyCachedBackgrounds(container: JQuery<HTMLElement>): void {
    container.find('.preset_card_bg_image').each(function () {
        const url = $(this).data('bg-url') as string | undefined;
        if (url && !$(this).css('background-image').includes('url(')) {
            getCachedImageURL(url).then(cachedUrl => {
                $(this).css('background-image', `url('${cachedUrl}')`);
            });
        }
    });
}

export async function clearImageCache(): Promise<boolean> {
    const db = await initCacheDb();
    if (!db) return false;
    return new Promise<boolean>((resolve) => {
        const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
        const store = tx.objectStore(CACHE_STORE_NAME);
        const req = store.clear();
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
    });
}
