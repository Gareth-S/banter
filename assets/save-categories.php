
<?php
/*
 * Banter — save category order
 *
 * Accepts a JSON array of categories and safely saves it to
 * data/categories.json.
 *
 * Safety measures:
 * - Requires a secret token.
 * - Accepts POST requests only.
 * - Validates the complete category list before saving.
 * - Writes to a temporary file in the same directory.
 * - Checks the temporary file before atomically replacing the original.
 *
 * This endpoint does not rename or delete category files.
 */

// Return JSON responses to the caller.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

// Send a JSON response and stop processing.
function respond(int $status, array $result): void
{
    http_response_code($status);
    echo json_encode($result);
    exit;
}

// --------------------------------------------------
// 1. Require POST
// --------------------------------------------------

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    respond(405, ['ok' => false, 'error' => 'POST required']);
}

// --------------------------------------------------
// 2. Authorisation
// --------------------------------------------------

// Set this value in a separate configuration file.
// Do not put the secret in JavaScript or in a public repository.
$configFile = __DIR__ . '/banter-config.php';

if (!is_file($configFile)) {
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

// The browser must send the token in the X-Banter-Token header.
$providedToken = $_SERVER['HTTP_X_BANTER_TOKEN'] ?? '';

if (
    !is_string($providedToken) ||
    !hash_equals($config['save_token'], $providedToken)
) {
    respond(403, ['ok' => false, 'error' => 'Not authorised']);
}

// --------------------------------------------------
// 3. Read and decode the submitted JSON
// --------------------------------------------------

$raw = file_get_contents('php://input');

if ($raw === false || $raw === '' || strlen($raw) > 100000) {
    respond(400, ['ok' => false, 'error' => 'Missing or oversized request']);
}

try {
    $submitted = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
} catch (JsonException $error) {
    respond(400, ['ok' => false, 'error' => 'Invalid JSON']);
}

// We expect a list of category objects.
// Use a sequential-key check instead of array_is_list(),
// which is unavailable on older PHP versions.
if (!is_array($submitted) ||
    array_keys($submitted) !== range(0, count($submitted) - 1)) {
    respond(400, ['ok' => false, 'error' => 'Expected a category list']);
}

if (count($submitted) > 100) {
    respond(400, ['ok' => false, 'error' => 'Too many categories']);
}

// --------------------------------------------------
// 4. Validate every category
// --------------------------------------------------

// Only existing category IDs and filenames are accepted.
// This prevents a submitted filename from choosing an arbitrary
// file for PHP to overwrite.
$categoriesFile = dirname(__DIR__) . '/data/categories.json';

if (!is_file($categoriesFile) || !is_readable($categoriesFile)) {
    respond(500, ['ok' => false, 'error' => 'Current category list unavailable']);
}

$currentJson = file_get_contents($categoriesFile);

try {
    $current = json_decode($currentJson, true, 32, JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    respond(500, ['ok' => false, 'error' => 'Current category JSON is invalid']);
}

if (!is_array($current) ||
    array_keys($current) !== range(0, count($current) - 1))  {
    respond(500, ['ok' => false, 'error' => 'Current category list is invalid']);
}


 // Build a list of the categories already known to the application.
 // The ID is the stable identifier; names and descriptions may change later.
$known = [];

foreach ($current as $category) {
    if (
        !is_array($category) ||
        !isset(
            $category['id'],
            $category['desc'],
            $category['name'],
            $category['file']
        ) ||
        !is_string($category['id']) ||
        !is_string($category['desc']) ||
        !is_string($category['name']) ||
        !is_string($category['file'])
    ) {
        respond(500, ['ok' => false, 'error' => 'Existing category entry is invalid']);
    }

    // An ID must be unique in the existing category list.
    if (isset($known[$category['id']])) {
        respond(500, ['ok' => false, 'error' => 'Duplicate category ID in saved data']);
    }

    $known[$category['id']] = $category;
}

// The submitted list must contain every existing category exactly once.
// For now, adding, deleting and renaming categories are not supported.
$seen = [];
$cleanCategories = [];

foreach ($submitted as $category) {
    if (
        !is_array($category) ||
        !isset($category['id']) ||
        !is_string($category['id'])
    ) {
        respond(400, ['ok' => false, 'error' => 'Invalid category entry']);
    }

    $id = $category['id'];

    if (!isset($known[$id]) || isset($seen[$id])) {
        respond(400, ['ok' => false, 'error' => 'Unknown or duplicate category']);
    }

    // Use the complete original entry, including desc, name and filename.
    // Ignore other submitted fields: only the order is being saved.
    $cleanCategories[] = $known[$id];
    $seen[$id] = true;
}

if (count($seen) !== count($known)) {
    respond(400, ['ok' => false, 'error' => 'Categories cannot be added or removed yet']);
}

// --------------------------------------------------
// 5. Prepare the complete new JSON in memory
// --------------------------------------------------

$newJson = json_encode(
    $cleanCategories,
    JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
);

if ($newJson === false) {
    respond(500, ['ok' => false, 'error' => 'Could not encode category data']);
}

$newJson .= PHP_EOL;

// --------------------------------------------------
// 6. Write and verify a temporary file
// --------------------------------------------------

// Use the same directory as the original so rename() can replace
// the file atomically on the same filesystem.
$tempFile = tempnam(dirname($categoriesFile), '.categories-');

if ($tempFile === false) {
    respond(500, ['ok' => false, 'error' => 'Could not create temporary file']);
}

$handle = fopen($tempFile, 'wb');

if ($handle === false) {
    @unlink($tempFile);
    respond(500, ['ok' => false, 'error' => 'Could not open temporary file']);
}

// Write the entire JSON, handling partial writes.
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

// Read the temporary file back and check it is complete and valid.
// Give the replacement file the same group-writable permissions
// as our existing JSON files, so digit can still edit them.
if (!$writeFailed && !chmod($tempFile, 0664)) {
    @unlink($tempFile);
    respond(500, [
        'ok' => false,
        'error' => 'Could not set temporary file permissions'
    ]);
}

// Read the temporary file back and check it is complete and valid.
$check = $writeFailed ? false : file_get_contents($tempFile);

if ($check !== $newJson) {
    @unlink($tempFile);
    respond(500, ['ok' => false, 'error' => 'Temporary file verification failed']);
}

try {
    $verified = json_decode($check, true, 32, JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    @unlink($tempFile);
    respond(500, ['ok' => false, 'error' => 'Temporary JSON verification failed']);
}

// --------------------------------------------------
// 7. Replace the live file
// --------------------------------------------------

// If this fails, the original file has not been replaced.
if (!rename($tempFile, $categoriesFile)) {
    @unlink($tempFile);
    respond(500, ['ok' => false, 'error' => 'Could not replace category file']);
}

// The complete new category list is now in place.
respond(200, ['ok' => true, 'message' => 'Categories saved']);
