
<?php
/*
 * Banter — save phrase order
 *
 * Accepts a category ID and an ordered list of phrase IDs.
 * The server looks up the permitted phrase filename in
 * categories.json; the browser never chooses a file path.
 *
 * Only phrase order is saved. Phrase IDs and text are preserved.
 */

// --------------------------------------------------
// 1. Common response helper
// --------------------------------------------------

function respond(int $status, array $result): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($result);
    exit;
}

// --------------------------------------------------
// 2. Require POST
// --------------------------------------------------

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(405, ['ok' => false, 'error' => 'POST required']);
}

// --------------------------------------------------
// 3. Load the existing private configuration
// --------------------------------------------------

$configFile = __DIR__ . '/banter-config.php';

if (!is_file($configFile) || !is_readable($configFile)) {
    respond(500, ['ok' => false, 'error' => 'Server configuration missing']);
}

$config = require $configFile;

if (!is_array($config) ||
    !isset($config['save_token']) ||
    !is_string($config['save_token'])) {
    respond(500, ['ok' => false, 'error' => 'Server configuration invalid']);
}

// --------------------------------------------------
// 4. Check the save token
// --------------------------------------------------

$headers = function_exists('getallheaders') ? getallheaders() : [];
$providedToken = '';

foreach ($headers as $name => $value) {
    if (strtolower($name) === 'x-banter-token' && is_string($value)) {
        $providedToken = $value;
        break;
    }
}

if (
    $providedToken === '' ||
    !hash_equals($config['save_token'], $providedToken)
) {
    respond(403, ['ok' => false, 'error' => 'Not authorised']);
}

// --------------------------------------------------
// 5. Read and validate the request JSON
// --------------------------------------------------

$raw = file_get_contents('php://input');

if ($raw === false || $raw === '' || strlen($raw) > 100000) {
    respond(400, ['ok' => false, 'error' => 'Missing or oversized request']);
}

try {
    $submitted = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    respond(400, ['ok' => false, 'error' => 'Invalid JSON']);
}

if (
    !is_array($submitted) ||
    !isset($submitted['categoryId'], $submitted['phraseIds']) ||
    !is_string($submitted['categoryId']) ||
    !is_array($submitted['phraseIds']) ||
    array_keys($submitted['phraseIds']) !==
        range(0, count($submitted['phraseIds']) - 1)
) {
    respond(400, ['ok' => false, 'error' => 'Invalid request structure']);
}

$categoryId = $submitted['categoryId'];
$phraseIds = $submitted['phraseIds'];

if (count($phraseIds) > 500) {
    respond(400, ['ok' => false, 'error' => 'Too many phrases']);
}

// --------------------------------------------------
// 6. Look up the permitted phrase file
// --------------------------------------------------

$categoriesFile = dirname(__DIR__) . '/data/categories.json';

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

$phraseFilename = null;

foreach ($categories as $category) {
    if (
        is_array($category) &&
        isset($category['id'], $category['file']) &&
        $category['id'] === $categoryId &&
        is_string($category['file'])
    ) {
        $phraseFilename = $category['file'];
        break;
    }
}

if ($phraseFilename === null) {
    respond(400, ['ok' => false, 'error' => 'Unknown category ID']);
}

// The filename comes from categories.json, not from the browser.
$dataDirectory = dirname(__DIR__) . '/data';
$phrasesFile = $dataDirectory . '/' . $phraseFilename;

if (!is_file($phrasesFile) || !is_readable($phrasesFile)) {
    respond(500, ['ok' => false, 'error' => 'Phrase file unavailable']);
}

// --------------------------------------------------
// 7. Load and validate the existing phrase list
// --------------------------------------------------

try {
    $phrases = json_decode(
        file_get_contents($phrasesFile),
        true,
        32,
        JSON_THROW_ON_ERROR
    );
} catch (Throwable $error) {
    respond(500, ['ok' => false, 'error' => 'Phrase JSON is invalid']);
}

if (
    !is_array($phrases) ||
    array_keys($phrases) !== range(0, count($phrases) - 1)
) {
    respond(500, ['ok' => false, 'error' => 'Phrase list is invalid']);
}

$known = [];

foreach ($phrases as $phrase) {
    if (
        !is_array($phrase) ||
        !isset($phrase['id'], $phrase['text']) ||
        !is_string($phrase['id']) ||
        !is_string($phrase['text']) ||
        isset($known[$phrase['id']])
    ) {
        respond(500, ['ok' => false, 'error' => 'Existing phrase entry is invalid']);
    }

    $known[$phrase['id']] = $phrase;
}

// --------------------------------------------------
// 8. Rebuild the list in the submitted order
// --------------------------------------------------

$seen = [];
$orderedPhrases = [];

foreach ($phraseIds as $id) {
    if (!is_string($id) || !isset($known[$id]) || isset($seen[$id])) {
        respond(400, ['ok' => false, 'error' => 'Unknown or duplicate phrase ID']);
    }

    // Keep the complete existing phrase, including its original text.
    $orderedPhrases[] = $known[$id];
    $seen[$id] = true;
}

if (count($seen) !== count($known)) {
    respond(400, ['ok' => false, 'error' => 'Phrases cannot be added or removed yet']);
}

// --------------------------------------------------
// 9. Encode the reordered phrase list
// --------------------------------------------------

$newJson = json_encode(
    $orderedPhrases,
    JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
);

if ($newJson === false) {
    respond(500, ['ok' => false, 'error' => 'Could not encode phrase data']);
}

$newJson .= PHP_EOL;

// --------------------------------------------------
// 10. Write a temporary file and verify it
// --------------------------------------------------

$tempFile = tempnam($dataDirectory, '.phrases-');

if ($tempFile === false) {
    respond(500, ['ok' => false, 'error' => 'Could not create temporary file']);
}

if (file_put_contents($tempFile, $newJson, LOCK_EX) !== strlen($newJson)) {
    unlink($tempFile);
    respond(500, ['ok' => false, 'error' => 'Could not write temporary file']);
}

$checkJson = file_get_contents($tempFile);

try {
    $checkData = json_decode($checkJson, true, 32, JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    unlink($tempFile);
    respond(500, ['ok' => false, 'error' => 'Temporary JSON verification failed']);
}

if ($checkData !== $orderedPhrases) {
    unlink($tempFile);
    respond(500, ['ok' => false, 'error' => 'Temporary file verification failed']);
}

if (!chmod($tempFile, 0664)) {
    unlink($tempFile);
    respond(500, ['ok' => false, 'error' => 'Could not set file permissions']);
}

if (!rename($tempFile, $phrasesFile)) {
    unlink($tempFile);
    respond(500, ['ok' => false, 'error' => 'Could not replace phrase file']);
}

// --------------------------------------------------
// 11. Report success
// --------------------------------------------------

respond(200, ['ok' => true, 'message' => 'Phrase order saved']);
