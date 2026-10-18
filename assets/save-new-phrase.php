
<?php
/*
 * Banter — add a phrase
 *
 * Accepts a category ID and phrase text.
 * Finds the category's existing phrase file using categories.json.
 * Generates the next stable phrase ID and appends the new phrase.
 *
 * Phrase IDs are unique within each category file.
 * Existing phrases and files are never overwritten by this operation.
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
    !isset($submitted['categoryId'], $submitted['text']) ||
    !is_string($submitted['categoryId']) ||
    !is_string($submitted['text'])
) {
    respond(400, ['ok' => false, 'error' => 'Category and phrase text are required']);
}

$categoryId = $submitted['categoryId'];
$phraseText = trim($submitted['text']);

if ($categoryId === '' || $phraseText === '') {
    respond(400, ['ok' => false, 'error' => 'Category and phrase text cannot be empty']);
}

if (strlen($phraseText) > 2000) {
    respond(400, ['ok' => false, 'error' => 'Phrase text is too long']);
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

if (!is_file($phraseFile) || !is_readable($phraseFile)) {
    respond(500, ['ok' => false, 'error' => 'Phrase file unavailable']);
}

// --------------------------------------------------
// 5. Load and validate the existing phrases
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

if (
    !is_array($phrases) ||
    array_keys($phrases) !== range(0, count($phrases) - 1)
) {
    // An empty JSON list is also valid.
    if ($phrases !== []) {
        respond(500, ['ok' => false, 'error' => 'Phrase list is invalid']);
    }
}

$prefix = null;
$highestNumber = 0;
$knownIds = [];

foreach ($phrases as $phrase) {
    if (
        !is_array($phrase) ||
        !isset($phrase['id'], $phrase['text']) ||
        !is_string($phrase['id']) ||
        !is_string($phrase['text']) ||
        !preg_match('/\A([a-z0-9]+-)([0-9]{3})\z/', $phrase['id'], $matches)
    ) {
        respond(500, ['ok' => false, 'error' => 'An existing phrase ID is invalid']);
    }

    $thisPrefix = $matches[1];
    $number = (int) $matches[2];

    if ($prefix !== null && $prefix !== $thisPrefix) {
        respond(500, ['ok' => false, 'error' => 'Phrase IDs use inconsistent prefixes']);
    }

    if (isset($knownIds[$phrase['id']])) {
        respond(500, ['ok' => false, 'error' => 'Duplicate phrase ID found']);
    }

    $prefix = $thisPrefix;
    $knownIds[$phrase['id']] = true;
    $highestNumber = max($highestNumber, $number);
}

// --------------------------------------------------
// 6. Choose a prefix for a new or empty category
// --------------------------------------------------

if ($prefix === null) {
    // Use the filename without its extension.
    $baseName = substr($category['file'], 0, -5);
    $words = preg_split('/-+/', $baseName, -1, PREG_SPLIT_NO_EMPTY);

    if (!$words) {
        respond(500, ['ok' => false, 'error' => 'Cannot generate phrase ID prefix']);
    }

    if (count($words) > 1) {
        $prefix = '';

        foreach ($words as $word) {
            $prefix .= $word[0];
        }
    } else {
        $prefix = substr($words[0], 0, 2);
    }

    $prefix .= '-';
}

// --------------------------------------------------
// 7. Generate the next phrase ID
// --------------------------------------------------

if ($highestNumber >= 999) {
    respond(400, ['ok' => false, 'error' => 'Phrase ID limit reached (999)']);
}

$newId = $prefix . str_pad((string) ($highestNumber + 1), 3, '0', STR_PAD_LEFT);

if (isset($knownIds[$newId])) {
    respond(500, ['ok' => false, 'error' => 'Generated phrase ID already exists']);
}

// --------------------------------------------------
// 8. Append the phrase and write it safely
// --------------------------------------------------

$phrases[] = [
    'id' => $newId,
    'text' => $phraseText
];

$newJson = json_encode(
    $phrases,
    JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
);

if ($newJson === false) {
    respond(500, ['ok' => false, 'error' => 'Could not encode phrase data']);
}

$newJson .= PHP_EOL;

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
    'message' => 'Phrase added',
    'phrase' => [
        'id' => $newId,
        'text' => $phraseText
    ]
]);
