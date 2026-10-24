
<?php
/*
 * Banter — add a category
 *
 * Accepts a category name and description.
 * Generates a unique category ID and phrase filename.
 * Creates an empty phrase file and appends the category
 * to data/categories.json.
 *
 * Existing category and phrase files are never overwritten.
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

$config = require $configFile;

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
    !hash_equals($config['save_token'], $providedToken)
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

// The category name is mandatory; the description is optional.
if (
    !is_array($submitted) ||
    !isset($submitted['name']) ||
    !is_string($submitted['name']) ||
    (isset($submitted['desc']) && !is_string($submitted['desc']))
) {
    respond(400, ['ok' => false, 'error' => 'A valid category name is required']);
}


// An omitted or blank description is stored as an empty string.
$name = trim($submitted['name']);
$desc = isset($submitted['desc'])
    ? trim($submitted['desc'])
    : '';

if ($name === '') {
    respond(400, ['ok' => false, 'error' => 'Category name cannot be empty']);
}


if (strlen($name) > 100 || strlen($desc) > 250) {
    respond(400, ['ok' => false, 'error' => 'Name or description is too long']);
}

// --------------------------------------------------
// 4. Load and validate the existing category list
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

if (
    !is_array($categories) ||
    array_keys($categories) !== range(0, count($categories) - 1)
) {
    respond(500, ['ok' => false, 'error' => 'Category list is invalid']);
}

if (count($categories) >= 100) {
    respond(400, ['ok' => false, 'error' => 'Category limit reached']);
}

$knownIds = [];
$knownFiles = [];
$maxId = 0;

foreach ($categories as $category) {
    if (
        !is_array($category) ||
        !isset($category['id'], $category['desc'], $category['name'], $category['file']) ||
        !is_string($category['id']) ||
        !is_string($category['desc']) ||
        !is_string($category['name']) ||
        !is_string($category['file']) ||
        isset($knownIds[$category['id']])
    ) {
        respond(500, ['ok' => false, 'error' => 'Existing category entry is invalid']);
    }

    $knownIds[$category['id']] = true;
    $knownFiles[$category['file']] = true;

    // Find the highest numeric category ID.
    if (preg_match('/^\d+$/', $category['id'])) {
        $maxId = max($maxId, (int) $category['id']);
    }
}

// --------------------------------------------------
// 5. Generate a unique category ID and filename
// --------------------------------------------------

// Keep IDs sequential, using at least two digits: 05, 06, etc.
$nextId = $maxId + 1;

do {
    $newId = sprintf('%02d', $nextId);
    $nextId++;
} while (isset($knownIds[$newId]));

// Make a safe filename from the category name.
$slug = strtolower($name);
$slug = preg_replace('/[^a-z0-9]+/', '-', $slug);
$slug = trim($slug, '-');

if ($slug === '') {
    $slug = 'category';
}

$baseSlug = $slug;
$suffix = 2;

while (
    isset($knownFiles[$slug . '.json']) ||
    file_exists($dataDirectory . '/' . $slug . '.json')
) {
    $slug = $baseSlug . '-' . $suffix;
    $suffix++;
}

$filename = $slug . '.json';
$phraseFile = $dataDirectory . '/' . $filename;

// --------------------------------------------------
// 6. Create the new, empty phrase file
// --------------------------------------------------

// Exclusive creation prevents accidentally overwriting a file.
$handle = fopen($phraseFile, 'x');

if ($handle === false) {
    respond(500, ['ok' => false, 'error' => 'Could not create phrase file']);
}

$emptyPhrases = "[]\n";
$length = strlen($emptyPhrases);
$written = 0;
$writeFailed = false;

while ($written < $length) {
    $result = fwrite($handle, substr($emptyPhrases, $written));

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

if (!$writeFailed && !chmod($phraseFile, 0664)) {
    $writeFailed = true;
}

if (
    $writeFailed ||
    file_get_contents($phraseFile) !== $emptyPhrases
) {
    @unlink($phraseFile);
    respond(500, ['ok' => false, 'error' => 'Could not verify phrase file']);
}

// --------------------------------------------------
// 7. Prepare the updated category list
// --------------------------------------------------

$categories[] = [
    'id' => $newId,
    'desc' => $desc,
    'name' => $name,
    'file' => $filename
];

$newJson = json_encode(
    $categories,
    JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
);

if ($newJson === false) {
    @unlink($phraseFile);
    respond(500, ['ok' => false, 'error' => 'Could not encode category data']);
}

$newJson .= PHP_EOL;

// --------------------------------------------------
// 8. Write and verify a temporary category file
// --------------------------------------------------

$tempFile = tempnam($dataDirectory, '.categories-');

if ($tempFile === false) {
    @unlink($phraseFile);
    respond(500, ['ok' => false, 'error' => 'Could not create temporary file']);
}

$handle = fopen($tempFile, 'wb');

if ($handle === false) {
    @unlink($tempFile);
    @unlink($phraseFile);
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
    @unlink($phraseFile);
    respond(500, ['ok' => false, 'error' => 'Temporary file verification failed']);
}

try {
    json_decode($check, true, 32, JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    @unlink($tempFile);
    @unlink($phraseFile);
    respond(500, ['ok' => false, 'error' => 'Temporary JSON verification failed']);
}

// --------------------------------------------------
// 9. Install the updated category list
// --------------------------------------------------

if (!rename($tempFile, $categoriesFile)) {
    @unlink($tempFile);
    @unlink($phraseFile);
    respond(500, ['ok' => false, 'error' => 'Could not replace category list']);
}

// Both files now exist and the category is registered.
respond(200, [
    'ok' => true,
    'message' => 'Category added',
    'category' => [
        'id' => $newId,
        'name' => $name,
        'desc' => $desc,
        'file' => $filename
    ]
]);
