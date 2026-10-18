
<?php
/*
 * Banter — delete a phrase
 *
 * Accepts a category ID and phrase ID.
 * Finds the phrase file through the trusted categories.json list.
 * Removes only the requested phrase; all other phrases keep their
 * existing IDs and order.
 */

// --------------------------------------------------
// 1. Common response helper
// --------------------------------------------------

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function respond(int $status, array $result): void
{
    http_response_code($status);
    echo json_encode($result);
    exit;
}

// --------------------------------------------------
// 2. Require POST and authorisation
// --------------------------------------------------

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    respond(405, ['ok' => false, 'error' => 'POST required']);
}

$configFile = __DIR__ . '/banter-config.php';

if (!is_file($configFile) || !is_readable($configFile)) {
    respond(500, ['ok' => false, 'error' => 'Server configuration missing']);
}

ob_start();
$config = require $configFile;
ob_end_clean();

if (
    !is_array($config) ||
    !isset($config['save_token']) ||
    !is_string($config['save_token']) ||
    $config['save_token'] === ''
) {
    respond(500, ['ok' => false, 'error' => 'Server configuration invalid']);
}

$providedToken = $_SERVER['HTTP_X_BANTER_TOKEN'] ?? '';

if (
    !is_string($providedToken) ||
    !hash_equals(trim($config['save_token']), $providedToken)
) {
    respond(403, ['ok' => false, 'error' => 'Not authorised']);
}

// --------------------------------------------------
// 3. Read and validate the request
// --------------------------------------------------

$raw = file_get_contents('php://input');

if ($raw === false || $raw === '' || strlen($raw) > 10000) {
    respond(400, ['ok' => false, 'error' => 'Missing or oversized request']);
}

try {
    $submitted = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
} catch (JsonException $error) {
    respond(400, ['ok' => false, 'error' => 'Invalid JSON']);
}

if (
    !is_array($submitted) ||
    !isset($submitted['categoryId'], $submitted['phraseId']) ||
    !is_string($submitted['categoryId']) ||
    !is_string($submitted['phraseId'])
) {
    respond(400, ['ok' => false, 'error' => 'Category and phrase IDs are required']);
}

$categoryId = $submitted['categoryId'];
$phraseId = $submitted['phraseId'];

if (
    !preg_match('/\A[0-9]{2}\z/', $categoryId) ||
    !preg_match('/\A[a-z0-9]+-[0-9]{3}\z/', $phraseId)
) {
    respond(400, ['ok' => false, 'error' => 'Invalid category or phrase ID']);
}

// --------------------------------------------------
// 4. Find the category using the trusted category list
// --------------------------------------------------

$dataDirectory = dirname(__DIR__) . '/data';
$categoriesFile = $dataDirectory . '/categories.json';

if (!is_file($categoriesFile) || !is_readable($categoriesFile)) {
    respond(500, ['ok' => false, 'error' => 'Category list unavailable']);
}

try {
    $categories = json_decode(
        file_get_contents($categoriesFile),
        true,
        32,
        JSON_THROW_ON_ERROR
    );
} catch (Throwable $error) {
    respond(500, ['ok' => false, 'error' => 'Category JSON is invalid']);
}

if (!is_array($categories)) {
    respond(500, ['ok' => false, 'error' => 'Category list is invalid']);
}

$category = null;

foreach ($categories as $entry) {
    if (
        is_array($entry) &&
        isset($entry['id']) &&
        is_string($entry['id']) &&
        $entry['id'] === $categoryId
    ) {
        $category = $entry;
        break;
    }
}

if (
    !is_array($category) ||
    !isset($category['file']) ||
    !is_string($category['file']) ||
    !preg_match('/\A[a-z0-9-]+\.json\z/', $category['file'])
) {
    respond(400, ['ok' => false, 'error' => 'Unknown or invalid category']);
}

$phraseFile = $dataDirectory . '/' . $category['file'];

if (!is_file($phraseFile) || !is_readable($phraseFile) || !is_writable($phraseFile)) {
    respond(500, ['ok' => false, 'error' => 'Phrase file unavailable or not writable']);
}

// --------------------------------------------------
// 5. Load the existing phrase list
// --------------------------------------------------

try {
    $phrases = json_decode(
        file_get_contents($phraseFile),
        true,
        32,
        JSON_THROW_ON_ERROR
    );
} catch (Throwable $error) {
    respond(500, ['ok' => false, 'error' => 'Phrase JSON is invalid']);
}

if (!is_array($phrases)) {
    respond(500, ['ok' => false, 'error' => 'Phrase list is invalid']);
}

if ($phrases !== [] && array_keys($phrases) !== range(0, count($phrases) - 1)) {
    respond(500, ['ok' => false, 'error' => 'Phrase list is invalid']);
}

// --------------------------------------------------
// 6. Find the exact phrase to remove
// --------------------------------------------------

$found = false;
$updatedPhrases = [];

foreach ($phrases as $phrase) {
    if (
        !is_array($phrase) ||
        !isset($phrase['id'], $phrase['text']) ||
        !is_string($phrase['id']) ||
        !is_string($phrase['text'])
    ) {
        respond(500, ['ok' => false, 'error' => 'An existing phrase is invalid']);
    }

    if ($phrase['id'] === $phraseId) {
        if ($found) {
            respond(500, ['ok' => false, 'error' => 'Duplicate phrase ID found']);
        }

        $found = true;
        continue;
    }

    $updatedPhrases[] = $phrase;
}

if (!$found) {
    respond(404, ['ok' => false, 'error' => 'Phrase not found']);
}

// --------------------------------------------------
// 7. Encode the updated list
// --------------------------------------------------

$newJson = json_encode(
    $updatedPhrases,
    JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
);

if ($newJson === false) {
    respond(500, ['ok' => false, 'error' => 'Could not encode phrase data']);
}

$newJson .= PHP_EOL;

// --------------------------------------------------
// 8. Write and verify a temporary file before replacing
// --------------------------------------------------

$tempFile = tempnam($dataDirectory, '.phrases-');

if ($tempFile === false) {
    respond(500, ['ok' => false, 'error' => 'Could not create temporary file']);
}

$handle = fopen($tempFile, 'wb');

if ($handle === false) {
    @unlink($tempFile);
    respond(500, ['ok' => false, 'error' => 'Could not open temporary file']);
}

$length = strlen($newJson);
$written = 0;
$writeFailed = false;

while ($written < $length) {
    $result = fwrite($handle, substr($newJson, $written));

    if ($result === false || $result === 0) {
        $writeFailed = true;
        break;
    }

    $written += $result;
}

if (!fflush($handle)) {
    $writeFailed = true;
}

if (function_exists('fsync') && !fsync($handle)) {
    $writeFailed = true;
}

fclose($handle);

if (!$writeFailed && !chmod($tempFile, 0664)) {
    $writeFailed = true;
}

$check = $writeFailed ? false : file_get_contents($tempFile);

if ($check !== $newJson) {
    @unlink($tempFile);
    respond(500, ['ok' => false, 'error' => 'Temporary file verification failed']);
}

try {
    json_decode($check, true, 32, JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    @unlink($tempFile);
    respond(500, ['ok' => false, 'error' => 'Temporary JSON verification failed']);
}

if (!rename($tempFile, $phraseFile)) {
    @unlink($tempFile);
    respond(500, ['ok' => false, 'error' => 'Could not replace phrase file']);
}

respond(200, [
    'ok' => true,
    'message' => 'Phrase deleted',
    'phraseId' => $phraseId
]);
