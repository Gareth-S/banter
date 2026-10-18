
<?php
/*
 * Banter — edit an existing phrase
 *
 * Accepts categoryId, phraseId and new text.
 * The category filename is obtained from categories.json,
 * never supplied by the browser.
 * Only the matching phrase's text is changed; its ID and
 * its position in the list are preserved.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function respond(int $status, array $result): void
{
    http_response_code($status);
    echo json_encode($result);
    exit;
}

// Require POST.
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    respond(405, ['ok' => false, 'error' => 'POST required']);
}

// Load the private configuration and save token.
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

// Read and validate the request.
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
    !isset($submitted['categoryId'], $submitted['phraseId'], $submitted['text']) ||
    !is_string($submitted['categoryId']) ||
    !is_string($submitted['phraseId']) ||
    !is_string($submitted['text'])
) {
    respond(400, ['ok' => false, 'error' => 'Category, phrase ID and text are required']);
}

$categoryId = $submitted['categoryId'];
$phraseId = $submitted['phraseId'];
$phraseText = trim($submitted['text']);

if (
    !preg_match('/\A[0-9]{2}\z/', $categoryId) ||
    !preg_match('/\A[a-z0-9]+-[0-9]{3}\z/', $phraseId)
) {
    respond(400, ['ok' => false, 'error' => 'Invalid category or phrase ID']);
}

if ($phraseText === '') {
    respond(400, ['ok' => false, 'error' => 'Phrase text cannot be empty']);
}

if (strlen($phraseText) > 2000) {
    respond(400, ['ok' => false, 'error' => 'Phrase text is too long']);
}

// Find the category in the trusted category list.
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

// Load the phrase list.
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

if (
    !is_array($phrases) ||
    ($phrases !== [] && array_keys($phrases) !== range(0, count($phrases) - 1))
) {
    respond(500, ['ok' => false, 'error' => 'Phrase list is invalid']);
}

// Change only the requested phrase's text.
$found = false;

foreach ($phrases as &$phrase) {
    if (
        !is_array($phrase) ||
        !isset($phrase['id'], $phrase['text']) ||
        !is_string($phrase['id']) ||
        !is_string($phrase['text'])
    ) {
        unset($phrase);
        respond(500, ['ok' => false, 'error' => 'An existing phrase is invalid']);
    }

    if ($phrase['id'] === $phraseId) {
        if ($found) {
            unset($phrase);
            respond(500, ['ok' => false, 'error' => 'Duplicate phrase ID found']);
        }

        $phrase['text'] = $phraseText;
        $found = true;
    }
}

unset($phrase);

if (!$found) {
    respond(404, ['ok' => false, 'error' => 'Phrase not found']);
}

// Encode the complete updated list.
$newJson = json_encode(
    $phrases,
    JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
);

if ($newJson === false) {
    respond(500, ['ok' => false, 'error' => 'Could not encode phrase data']);
}

$newJson .= PHP_EOL;

// Write to a temporary file before replacing the original.
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
    'message' => 'Phrase updated',
    'phrase' => [
        'id' => $phraseId,
        'text' => $phraseText
    ]
]);
