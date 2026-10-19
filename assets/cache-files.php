<?php

/*
 * Banter cache-file helper.
 *
 * Lists only approved public app files.
 * Never lists PHP files for offline caching.
 */

header("Content-Type: application/json; charset=utf-8");
header("Cache-Control: no-store, no-cache, must-revalidate");

$appRoot = dirname(__DIR__);

$files = [
    "index.html",
    "manifest.json"
];

/*
 * Static file types allowed from assets/.
 * PHP, backups and temporary files are excluded.
 */
$assetExtensions = [
    "js", "css",
    "png", "jpg", "jpeg", "webp", "svg", "ico",
    "woff", "woff2", "ttf", "otf",
    "mp3", "wav"
];

$assetRoot = $appRoot . "/assets";

if (is_dir($assetRoot)) {
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator(
            $assetRoot,
            FilesystemIterator::SKIP_DOTS
        )
    );

    foreach ($iterator as $file) {
        if (!$file->isFile()) {
            continue;
        }

        $extension = strtolower($file->getExtension());

        if (!in_array($extension, $assetExtensions, true)) {
            continue;
        }

        $relative = substr(
            $file->getPathname(),
            strlen($appRoot) + 1
        );

        $files[] = str_replace(DIRECTORY_SEPARATOR, "/", $relative);
    }
}

/*
 * Include every JSON data file, including new categories.
 */
$dataRoot = $appRoot . "/data";

if (is_dir($dataRoot)) {
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator(
            $dataRoot,
            FilesystemIterator::SKIP_DOTS
        )
    );

    foreach ($iterator as $file) {
        if (!$file->isFile()) {
            continue;
        }

        if (strtolower($file->getExtension()) !== "json") {
            continue;
        }

        $relative = substr(
            $file->getPathname(),
            strlen($appRoot) + 1
        );

        $files[] = str_replace(DIRECTORY_SEPARATOR, "/", $relative);
    }
}

$files = array_values(array_unique($files));
sort($files);

echo json_encode(
    ["files" => $files],
    JSON_UNESCAPED_SLASHES
);
