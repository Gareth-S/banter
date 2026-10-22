/*
 * Banter v1.0 service worker
 *
 * Online: network first; refresh the offline cache.
 * Offline: use cached app files and data.
 * PHP requests: never cached or queued.
 */

const CACHE_NAME = "banter-v1.0";
const APP_SCOPE = self.registration.scope;


/*
 * Discover and refresh the approved cache files.
 *
 * The PHP helper supplies the current file list.
 * A failed download does not erase an older cached copy.
 */
async function refreshCache() {
    const listURL = new URL(
        "assets/cache-files.php",
        APP_SCOPE
    );

    const listResponse = await fetch(listURL.href, {
        cache: "no-store"
    });

    if (!listResponse.ok) {
        throw new Error("Could not retrieve Banter cache file list");
    }

    const result = await listResponse.json();

    if (!Array.isArray(result.files)) {
        throw new Error("Invalid Banter cache file list");
    }

    const cache = await caches.open(CACHE_NAME);
    const currentFiles = new Set();
    let everyFileFetched = true;

    /*
     * Download the latest versions of all listed files.
     */
    await Promise.all(
        result.files.map(async path => {
            const fileURL = new URL(path, APP_SCOPE);

            /*
             * Safety check: only cache files within this app.
             */
            if (
                fileURL.origin !== self.location.origin ||
                !fileURL.pathname.startsWith(
                    new URL(APP_SCOPE).pathname
                )
            ) {
                everyFileFetched = false;
                return;
            }

            currentFiles.add(fileURL.href);

            try {
                const response = await fetch(fileURL.href, {
                    cache: "no-store"
                });

                if (
                    !response.ok ||
                    response.type !== "basic"
                ) {
                    everyFileFetched = false;
                    return;
                }

                await cache.put(
                    fileURL.href,
                    response.clone()
                );
            } catch (error) {
                everyFileFetched = false;
                console.warn(
                    "Banter: keeping previous cached copy of",
                    path,
                    error
                );
            }
        })
    );

    /*
     * Remove obsolete cached assets/data only after a complete
     * successful refresh. This cleans up deleted categories.
     */
    if (everyFileFetched) {
        const appPath = new URL(APP_SCOPE).pathname;
        const keys = await cache.keys();

        for (const request of keys) {
            const url = new URL(request.url);

            if (!url.pathname.startsWith(appPath)) {
                continue;
            }

            const relativePath =
                url.pathname.slice(appPath.length);

            const isManagedFile =
                relativePath.startsWith("assets/") ||
                relativePath.startsWith("data/");

            if (
                isManagedFile &&
                !url.search &&
                !currentFiles.has(url.href)
            ) {
                await cache.delete(request);
            }
        }
    }

    console.log(
        "Banter: cache refresh complete",
        everyFileFetched ? "(all files fetched)" : "(some files unavailable)"
    );
}



/*
 * Refresh selected JSON files after a successful edit/save.
 *
 * Every requested file must refresh successfully. If a request fails,
 * throw an error so the message handler can report the failure.
 * A failed download never overwrites the previous cached copy.
 */
async function refreshFiles(paths) {
    if (!Array.isArray(paths)) {
        throw new Error("Invalid Banter refresh file list");
    }

    const cache = await caches.open(CACHE_NAME);
    const appPath = new URL(APP_SCOPE).pathname;

    for (const path of paths) {
        // Accept only JSON files inside the app's data folder.
        if (
            typeof path !== "string" ||
            !path.startsWith("data/") ||
            !path.toLowerCase().endsWith(".json") ||
            path.includes("..") ||
            path.includes("?") ||
            path.includes("#")
        ) {
            throw new Error("Invalid Banter data file path");
        }

        const fileURL = new URL(path, APP_SCOPE);

        // Never allow a refresh request outside this app's data folder.
        if (
            fileURL.origin !== self.location.origin ||
            !fileURL.pathname.startsWith(appPath + "data/") ||
            !fileURL.pathname.toLowerCase().endsWith(".json")
        ) {
            throw new Error("Banter refresh path is outside the data folder");
        }

        const response = await fetch(fileURL.href, {
            cache: "no-store"
        });

        if (!response.ok || response.type !== "basic") {
            throw new Error(`Could not refresh ${path}`);
        }

        await cache.put(fileURL.href, response.clone());
    }
}



/*
 * Install: build the initial offline cache.
 */
self.addEventListener("install", event => {
    event.waitUntil(
        (async () => {
            await refreshCache();
            await self.skipWaiting();
        })()
    );
});


/*
 * Activate: remove older Banter caches and take control.
 */
self.addEventListener("activate", event => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();

            await Promise.all(
                keys
                    .filter(
                        key =>
                            key.startsWith("banter-") &&
                            key !== CACHE_NAME
                    )
                    .map(key => caches.delete(key))
            );

            await self.clients.claim();
        })()
    );
});



/*
 * Handle requests from the app to refresh its offline cache.
 *
 * REFRESH_CACHE refreshes the complete approved file list.
 * REFRESH_FILES updates only the JSON files changed by a save.
 * Reply through the supplied MessageChannel so the page knows
 * when the requested operation has finished.
 */
self.addEventListener("message", event => {
    if (event.data?.type === "REFRESH_CACHE") {
        event.waitUntil(
            (async () => {
                try {
                    await refreshCache();
                    event.ports[0]?.postMessage({
                        type: "REFRESH_COMPLETE",
                        ok: true
                    });
                } catch (error) {
                    console.warn(
                        "Banter: background cache refresh failed",
                        error
                    );

                    event.ports[0]?.postMessage({
                        type: "REFRESH_COMPLETE",
                        ok: false
                    });
                }
            })()
        );

        return;
    }

    if (event.data?.type === "REFRESH_FILES") {
        event.waitUntil(
            (async () => {
                try {
                    await refreshFiles(event.data.files || []);

                    event.ports[0]?.postMessage({
                        type: "REFRESH_COMPLETE",
                        ok: true
                    });
                } catch (error) {
                    console.warn(
                        "Banter: requested cache refresh failed",
                        error
                    );

                    event.ports[0]?.postMessage({
                        type: "REFRESH_COMPLETE",
                        ok: false
                    });
                }
            })()
        );
    }
});




/*
 * Network first, cached fallback.
 *
 * GET requests only.
 * PHP endpoints and cross-origin requests bypass this handler.
 */
self.addEventListener("fetch", event => {
    const request = event.request;
    const url = new URL(request.url);

    if (
        request.method !== "GET" ||
        url.origin !== self.location.origin ||
        url.pathname.toLowerCase().endsWith(".php")
    ) {
        return;
    }

    event.respondWith(
        (async () => {
            /*
             * Phrase/category JSON is cache-first for instant performance use.
             * The startup and scheduled refreshes update these copies when
             * online; a cache miss still gets one bounded browser fetch.
             */
            if (
                url.pathname.includes("/data/") &&
                url.pathname.toLowerCase().endsWith(".json")
            ) {
                const cached = await caches.match(request);
                if (cached) {
                    return cached;
                }
            }

            try {
                const response = await fetch(request);

                if (response.ok && response.type === "basic") {
                    const cache = await caches.open(CACHE_NAME);

                    await cache.put(
                        request,
                        response.clone()
                    );

                    return response;
                }

                /*
                 * If the server returns an error, use a cached
                 * copy if one exists; otherwise return the error.
                 */
                const cached = await caches.match(request);

                if (cached) {
                    return cached;
                }

                return response;
            } catch (error) {
                /*
                 * Network unavailable: try the exact URL first.
                 */
                let cached = await caches.match(request);

                /*
                 * Also try the same URL without query parameters.
                 */
                if (!cached && url.search) {
                    const cleanURL =
                        url.origin + url.pathname;

                    cached = await caches.match(cleanURL);
                }

                if (cached) {
                    return cached;
                }

                /*
                 * Offline navigation fallback.
                 */
                if (request.mode === "navigate") {
                    cached = await caches.match(
                        new URL("index.html", APP_SCOPE).href
                    );

                    if (cached) {
                        return cached;
                    }
                }

                throw error;
            }
        })()
    );
});
