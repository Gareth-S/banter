<?php
/*
 * Banter — delete a category and transfer its phrases to Bucket
 *
 * This is deliberately a dedicated operation: deleting a category touches
 * both its phrase data and the trusted category list. Phrases are written
 * to Bucket first; the category is removed from categories.json only after
 * the new Bucket file has been verified and installed.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function isListArray(array $value): bool
{
    return $value === [] || array_keys($value) === range(0, count($value) - 1);
}

function respond(int $status, array $result): void
{
    http_response_code($status);
    echo json_encode($result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

/* Write and verify a complete JSON file beside its destination, then rename. */
function prepareJsonTemp(string $directory, string $json)
{
    $tempFile = tempnam($directory, '.category-delete-');
    if ($tempFile === false) {
        return false;
    }

    $handle = fopen($tempFile, 'wb');
    if ($handle === false) {
        @unlink($tempFile);
        return false;
    }

    $length = strlen($json);
    $written = 0;
    $failed = false;

    while ($written < $length) {
        $result = fwrite($handle, substr($json, $written));
        if ($result === false || $result === 0) {
            $failed = true;
            break;
        }
        $written += $result;
    }

    if (!fflush($handle)) {
        $failed = true;
    }
    if (function_exists('fsync') && !fsync($handle)) {
        $failed = true;
    }
    fclose($handle);

    if (!$failed && !chmod($tempFile, 0664)) {
        $failed = true;
    }

    $check = $failed ? false : file_get_contents($tempFile);
    if ($check !== $json) {
        @unlink($tempFile);
        return false;
    }

    try {
        json_decode($check, true, 64, JSON_THROW_ON_ERROR);
    } catch (Throwable $error) {
        @unlink($tempFile);
        return false;
    }

    return $tempFile;
}

function writeJsonAtomically(string $directory, string $destination, string $json): bool
{
    $tempFile = prepareJsonTemp($directory, $json);
    if ($tempFile === false) {
        return false;
    }
    if (!rename($tempFile, $destination)) {
        @unlink($tempFile);
        return false;
    }
    return true;
}

// Require POST and the same save token used by the other editing endpoints.
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
if (!is_array($config) || !isset($config['save_token']) ||
    !is_string($config['save_token']) || trim($config['save_token']) === '') {
    respond(500, ['ok' => false, 'error' => 'Server configuration invalid']);
}
$providedToken = $_SERVER['HTTP_X_BANTER_TOKEN'] ?? '';
if (!is_string($providedToken) || !hash_equals(trim($config['save_token']), $providedToken)) {
    respond(403, ['ok' => false, 'error' => 'Not authorised']);
}

$raw = file_get_contents('php://input');
if ($raw === false || $raw === '' || strlen($raw) > 10000) {
    respond(400, ['ok' => false, 'error' => 'Missing or oversized request']);
}
try {
    $submitted = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    respond(400, ['ok' => false, 'error' => 'Invalid JSON']);
}
if (!is_array($submitted) || !isset($submitted['categoryId']) ||
    !is_string($submitted['categoryId']) ||
    !preg_match('/\A[0-9]{2}\z/', $submitted['categoryId'])) {
    respond(400, ['ok' => false, 'error' => 'A valid category ID is required']);
}
$categoryId = $submitted['categoryId'];

$dataDirectory = dirname(__DIR__) . '/data';
$categoriesFile = $dataDirectory . '/categories.json';
$bucketFile = $dataDirectory . '/bucket.json';
if (!is_dir($dataDirectory) || !is_readable($categoriesFile) || !is_writable($dataDirectory) ||
    !is_readable($bucketFile) || !is_writable($bucketFile)) {
    respond(500, ['ok' => false, 'error' => 'Category or Bucket files are unavailable']);
}

// Serialize category deletions so two requests cannot transfer the same list at once.
$lock = fopen($dataDirectory . '/.category-delete.lock', 'c');
if ($lock === false || !flock($lock, LOCK_EX)) {
    if (is_resource($lock)) fclose($lock);
    respond(500, ['ok' => false, 'error' => 'Could not lock category data']);
}

try {
    $categoriesJson = file_get_contents($categoriesFile);
    $bucketJson = file_get_contents($bucketFile);
    if ($categoriesJson === false || $bucketJson === false) {
        throw new RuntimeException('Could not read category data');
    }

    $categories = json_decode($categoriesJson, true, 64, JSON_THROW_ON_ERROR);
    $bucketPhrases = json_decode($bucketJson, true, 64, JSON_THROW_ON_ERROR);
    if (!is_array($categories) || !isListArray($categories) ||
        !is_array($bucketPhrases) || !isListArray($bucketPhrases)) {
        throw new RuntimeException('Category or Bucket JSON is not a valid list');
    }

    $targetIndex = null;
    $target = null;
    $bucketIndex = null;
    foreach ($categories as $index => $entry) {
        if (!is_array($entry) || !isset($entry['id'], $entry['file']) ||
            !is_string($entry['id']) || !is_string($entry['file'])) {
            throw new RuntimeException('Category list contains an invalid entry');
        }
        if ($entry['id'] === '10' || $entry['file'] === 'bucket.json') {
            if ($entry['id'] !== '10' || $entry['file'] !== 'bucket.json') {
                throw new RuntimeException('Bucket identity is inconsistent; no changes were made');
            }
            $bucketIndex = $index;
        }
        if ($entry['id'] === $categoryId) {
            $targetIndex = $index;
            $target = $entry;
        }
    }

    if ($bucketIndex === null) {
        throw new RuntimeException('Bucket is missing from the category list; no changes were made');
    }
    if ($categoryId === '10') {
        throw new InvalidArgumentException('Bucket is permanent and cannot be deleted');
    }
    if ($targetIndex === null || !is_array($target) ||
        !isset($target['file']) || !is_string($target['file']) ||
        !preg_match('/\A[a-z0-9-]+\.json\z/', $target['file'])) {
        throw new InvalidArgumentException('Unknown or invalid category');
    }

    $sourceFile = $dataDirectory . '/' . $target['file'];
    if ($target['file'] === 'bucket.json' || !is_readable($sourceFile)) {
        throw new RuntimeException('The category phrase file is unavailable');
    }
    $sourceJson = file_get_contents($sourceFile);
    if ($sourceJson === false) {
        throw new RuntimeException('Could not read the category phrase file');
    }
    $sourcePhrases = json_decode($sourceJson, true, 64, JSON_THROW_ON_ERROR);
    if (!is_array($sourcePhrases) || !isListArray($sourcePhrases)) {
        throw new RuntimeException('The category phrase file is not a valid list');
    }

    // Validate Bucket IDs and determine the next unused number in its prefix.
    $bucketPrefix = null;
    $highestNumber = 0;
    $knownBucketIds = [];
    foreach ($bucketPhrases as $phrase) {
        if (!is_array($phrase) || !isset($phrase['id'], $phrase['text']) ||
            !is_string($phrase['id']) || !is_string($phrase['text']) ||
            !preg_match('/\A([a-z0-9]+-)([0-9]{3})\z/', $phrase['id'], $matches)) {
            throw new RuntimeException('A Bucket phrase has an invalid ID or structure');
        }
        if ($bucketPrefix !== null && $bucketPrefix !== $matches[1]) {
            throw new RuntimeException('Bucket phrase IDs use inconsistent prefixes');
        }
        if (isset($knownBucketIds[$phrase['id']])) {
            throw new RuntimeException('Duplicate phrase ID found in Bucket');
        }
        $bucketPrefix = $matches[1];
        $knownBucketIds[$phrase['id']] = true;
        $highestNumber = max($highestNumber, (int)$matches[2]);
    }
    if ($bucketPrefix === null) {
        $bucketPrefix = 'bu-';
    }

    // Validate source phrases before changing either live file.
    $sourceIds = [];
    foreach ($sourcePhrases as $phrase) {
        if (!is_array($phrase) || !isset($phrase['id'], $phrase['text']) ||
            !is_string($phrase['id']) || !is_string($phrase['text']) ||
            !preg_match('/\A[a-z0-9]+-[0-9]{3}\z/', $phrase['id'])) {
            throw new RuntimeException('A source phrase has an invalid ID or structure');
        }
        if (isset($sourceIds[$phrase['id']])) {
            throw new RuntimeException('Duplicate phrase ID found in the source category');
        }
        $sourceIds[$phrase['id']] = true;
    }

    if (count($bucketPhrases) + count($sourcePhrases) > 999 ||
        $highestNumber + count($sourcePhrases) > 999) {
        throw new RuntimeException('Bucket has reached its phrase ID limit; no changes were made');
    }

    $transferred = 0;
    foreach ($sourcePhrases as $phrase) {
        $highestNumber++;
        $phrase['id'] = $bucketPrefix . str_pad((string)$highestNumber, 3, '0', STR_PAD_LEFT);
        $bucketPhrases[] = $phrase;
        $transferred++;
    }

    $newBucketJson = json_encode($bucketPhrases,
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) . PHP_EOL;
    array_splice($categories, $targetIndex, 1);
    $newCategoriesJson = json_encode($categories,
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) . PHP_EOL;

    // Prepare and verify both files before replacing either live file.
    $bucketTemp = prepareJsonTemp($dataDirectory, $newBucketJson);
    $categoriesTemp = prepareJsonTemp($dataDirectory, $newCategoriesJson);
    if ($bucketTemp === false || $categoriesTemp === false) {
        if ($bucketTemp !== false) @unlink($bucketTemp);
        if ($categoriesTemp !== false) @unlink($categoriesTemp);
        throw new RuntimeException('Could not prepare verified replacement files; no changes were made');
    }

    // Bucket first: if category-list replacement fails, the category still
    // exists. Attempt to restore the original Bucket file before reporting.
    if (!rename($bucketTemp, $bucketFile)) {
        @unlink($bucketTemp);
        @unlink($categoriesTemp);
        throw new RuntimeException('Could not install the updated Bucket file; no changes were made');
    }

    if (!rename($categoriesTemp, $categoriesFile)) {
        @unlink($categoriesTemp);
        $rolledBack = writeJsonAtomically($dataDirectory, $bucketFile, $bucketJson);
        if (!$rolledBack) {
            throw new RuntimeException('Category removal failed and automatic rollback could not be confirmed. Phrases remain safe, but check Bucket and the category list before retrying.');
        }
        throw new RuntimeException('Could not update the category list. Bucket was restored and no deletion was completed.');
    }

    // Both live JSON files are now updated. Remove the old phrase file last;
    // if cleanup fails, report it without pretending the transfer was undone.
    $sourceFileRemoved = !file_exists($sourceFile) || @unlink($sourceFile);

    flock($lock, LOCK_UN);
    fclose($lock);
    respond(200, [
        'ok' => true,
        'message' => $sourceFileRemoved
            ? 'Category deleted; phrases transferred to Bucket'
            : 'Category deleted and phrases transferred, but the old phrase file could not be removed',
        'cleanupWarning' => !$sourceFileRemoved,
        'categoryId' => $categoryId,
        'transferred' => $transferred
    ]);
} catch (InvalidArgumentException $error) {
    flock($lock, LOCK_UN);
    fclose($lock);
    respond(400, ['ok' => false, 'error' => $error->getMessage()]);
} catch (Throwable $error) {
    error_log('Banter delete-category: ' . $error->getMessage());
    flock($lock, LOCK_UN);
    fclose($lock);
    respond(500, ['ok' => false, 'error' => $error->getMessage()]);
}
