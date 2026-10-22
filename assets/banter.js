
/*
 * Banter — main application logic
 *
 * Current features:
 * - Load categories from data/categories.json
 * - Display the category home screen
 * - Open a category to display its phrases
 * - Mark phrases as used during performance mode
 * - Toggle between performance mode and Edit mode
 * - Drag categories into a new order while editing
 *
 * IMPORTANT:
 * Category reordering currently changes memory only.
 * Saving the new order will be added in a later step.
 */

// --------------------------------------------------
// Shared application state
// --------------------------------------------------

// Phrase IDs are kept here once used, so they can be
// greyed out if their category is opened again.
// This set resets when the page is reloaded.
const usedPhrases = new Set();

// --------------------------------------------------
// Phrase return timer
// --------------------------------------------------

// Remember the selected delay on this device; zero means return immediately.
const PHRASE_DELAY_KEY = "banterPhraseDelay";
let phraseReturnTimer = null;

function clearPhraseReturnTimer() {
    if (phraseReturnTimer !== null) {
        window.clearTimeout(phraseReturnTimer);
        phraseReturnTimer = null;
    }
}

// --------------------------------------------------
// Four-hour performance-session maintenance
// --------------------------------------------------

// 4 hr regular timer
const MAINTENANCE_INTERVAL_MS = 4 * 60 * 60 * 1000;

// 2 min test timer
// const MAINTENANCE_INTERVAL_MS = 60 * 1000;

const MAINTENANCE_CHECK_MS = 3 * 60 * 1000;
const MAINTENANCE_STORAGE_KEY = "banterLastMaintenance";

let activeCategory = null;

// Clear used phrases and redraw the phrase list if appropriate.
function resetUsedPhrases() {
    usedPhrases.clear();

    // Don't rebuild the screen while the user is editing.
    // That could discard an in-progress edit.
    if (
        !editMode &&
        currentScreen === "phrases" &&
        activeCategory
    ) {
        showPhrases(activeCategory);
    }
}

// Check whether four hours have elapsed since maintenance.
function checkMaintenance() {
    let lastMaintenance = 0;

    try {
        lastMaintenance = Number(
            localStorage.getItem(MAINTENANCE_STORAGE_KEY)
        );
    } catch (error) {
        console.warn("Banter: could not read maintenance time.", error);
    }

    // No timestamp means this is a new session.
    // Startup already requests a cache refresh separately.
    if (!lastMaintenance) {
        return;
    }

    if (Date.now() - lastMaintenance < MAINTENANCE_INTERVAL_MS) {
        return;
    }

    // Record the time before doing the work, so returning from
    // suspension won't trigger the same maintenance repeatedly.
    try {
        localStorage.setItem(
            MAINTENANCE_STORAGE_KEY,
            String(Date.now())
        );
    } catch (error) {
        console.warn("Banter: could not save maintenance time.", error);
    }

    resetUsedPhrases();

    // Ask the service worker to refresh its cache.
    // The listener in index.html will handle online/offline status.
    window.dispatchEvent(
        new Event("banter-cache-refresh-requested")
    );
}

// Start a new session's four-hour countdown.
function startMaintenanceTimer() {
    try {
        localStorage.setItem(
            MAINTENANCE_STORAGE_KEY,
            String(Date.now())
        );
    } catch (error) {
        console.warn("Banter: could not save maintenance time.", error);
    }

    // The usedPhrases Set is new and empty at startup.
    // Check periodically, without polling the server.
    window.setInterval(checkMaintenance, MAINTENANCE_CHECK_MS);

    // Timers may be suspended while the phone sleeps.
    // Check again when the app returns to the foreground.
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            checkMaintenance();
        }
    });

    window.addEventListener("pageshow", checkMaintenance);
    window.addEventListener("focus", checkMaintenance);
}

// Main page elements, defined in index.html.
const app = document.getElementById("app");
const editModeBtn = document.getElementById("editModeBtn");

// Theme toggle button.
const themeToggleBtn = document.getElementById("themeToggleBtn");

/*
 * Bound network waits so a missing connection cannot leave Banter
 * waiting forever. A timeout on a save means the result may be uncertain:
 * the server could have saved the change before the reply was lost.
 */
const SAVE_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options = {}, timeoutMs = SAVE_TIMEOUT_MS) {
    const controller = new AbortController();
    let timeoutId;
    let timerCleared = false;

    const clearTimeoutOnce = () => {
        if (!timerCleared) {
            window.clearTimeout(timeoutId);
            timerCleared = true;
        }
    };

    // Keep the timeout active while the response body is being read too.
    // A connection can fail after headers arrive but before the JSON does.
    timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });

        // Most Banter requests read JSON. Wrap that step so the timeout is
        // cleared only after the body has been fully received or has failed.
        const originalJson = response.json.bind(response);
        response.json = (...args) =>
            originalJson(...args).finally(clearTimeoutOnce);

        const originalText = response.text.bind(response);
        response.text = (...args) =>
            originalText(...args).finally(clearTimeoutOnce);

        return response;
    } catch (error) {
        clearTimeoutOnce();
        throw error;
    }
}

/*
 * Test the actual server, not just navigator.onLine. The PHP cache-file
 * list endpoint is not cached by the service worker, so success means the
 * server answered. Callers can use a short timeout for the Edit-mode gate.
 */
async function checkServer(timeoutMs = 3000) {
    const response = await fetchWithTimeout(
        `assets/cache-files.php?check=${Date.now()}`,
        { cache: "no-store" },
        timeoutMs
    );

    if (!response.ok) {
        throw new Error(`Server check returned HTTP ${response.status}`);
    }

    const result = await response.json();
    if (!Array.isArray(result.files)) {
        throw new Error("Server returned an invalid response");
    }

    return true;
}

/* Ask the service worker to refresh its approved offline files after saves. */
async function refreshCachedData(files = []) {
    if (!navigator.onLine) {
        return;
    }

    const controller = navigator.serviceWorker?.controller;
    if (!controller) {
        return;
    }

    // Refresh only the JSON files changed by this save, then reload the UI.
    // A short ceiling means cache trouble cannot trap the editor.
    return new Promise(resolve => {
        const channel = new MessageChannel();
        const timeoutId = window.setTimeout(() => {
            channel.port1.close();
            resolve();
        }, 8000);

        channel.port1.onmessage = () => {
            window.clearTimeout(timeoutId);
            channel.port1.close();
            resolve();
        };

        controller.postMessage(
            { type: "REFRESH_FILES", files },
            [channel.port2]
        );
    });
}

// Apply a theme and remember the choice on this device.
function setTheme(theme) {
    const lightTheme = theme === "light";

    document.body.classList.toggle("light-theme", lightTheme);

    // Show the alternative theme on the button.
    themeToggleBtn.textContent = lightTheme
        ? "☾ Dark theme"
        : "☀ Light theme";

    // Keep the browser UI colour in step with the page.
    const themeColour = lightTheme ? "#f8f9fa" : "#202124";
    const themeMeta = document.querySelector('meta[name="theme-color"]');

    if (themeMeta) {
        themeMeta.content = themeColour;
    }

    // Save the selection locally; no server request is needed.
    try {
        localStorage.setItem("banterTheme", lightTheme ? "light" : "dark");
    } catch (error) {
        console.warn("Banter: could not save theme preference.", error);
    }
}

// Restore the saved theme, defaulting to dark for existing users.
function loadTheme() {
    let savedTheme = "dark";

    try {
        savedTheme = localStorage.getItem("banterTheme") || "dark";
    } catch (error) {
        console.warn("Banter: could not read theme preference.", error);
    }

    setTheme(savedTheme);
}

// Switch themes when the button is pressed.
themeToggleBtn.addEventListener("click", () => {
    const isLight = document.body.classList.contains("light-theme");
    setTheme(isLight ? "dark" : "light");
});


// Displays save success or failure messages to the user.
let saveMessage = "";

// Data loaded from JSON and the current interface mode.
let categories = [];
let editMode = false;

// Keep the saved category order so a failed save can be cancelled safely.
let originalCategoryOrder = [];

// Reference to the active SortableJS instance.
// Keeping this lets us destroy it when leaving Edit mode.
let categorySorter = null;

// --------------------------------------------------
// Phrase editing state
// --------------------------------------------------

// The category currently open on the phrase screen.
// let activeCategory = null;

// The phrases currently displayed, in their current order.
let activePhrases = [];

// Reference to the active phrase drag-and-drop instance.
let phraseSorter = null;


// Which screen is currently displayed: "home" or "phrases".
let currentScreen = "home";

// ID of the phrase currently being edited, or null when none is.
let editingPhraseId = null;

// Original phrase ID order when the category was loaded.
let originalPhraseOrder = [];


// --------------------------------------------------
// Load category data
// --------------------------------------------------

async function loadCategories() {
    try {
        // Read the category list from the JSON file.
//        const response = await fetch("data/categories.json");

        // Category order can change during editing, so always request
        // the latest saved version rather than relying on browser cache.
            const response = await fetchWithTimeout("data/categories.json", {}, 8000);
        
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        categories = await response.json();

        // Display the home screen once the data is ready.
        showHome();

    } catch (error) {
        console.error("Banter:", error);

        app.textContent =
            "Unable to load categories. Check the JSON file.";
    }
}


// --------------------------------------------------
// Edit mode
// --------------------------------------------------


/*
 * Save the current category order to the PHP endpoint.
 *
 * Only category IDs are sent. The server reconstructs the
 * complete category objects from its existing trusted data.
 */
async function saveCategoryOrder() {
    try {
        const response = await fetchWithTimeout("assets/save-categories.php", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Banter-Token": window.BANTER_SAVE_TOKEN
            },
            body: JSON.stringify(
                categories.map(category => ({ id: category.id }))
            )
        });

        // Read the server response, including useful error messages.
        const result = await response.json();

        if (!response.ok || !result.ok) {
            throw new Error(result.error || `HTTP ${response.status}`);
        }

        await refreshCachedData(["data/categories.json"]);
        return true;

    } catch (error) {
        console.error("Banter: unable to save category order", error);

        saveMessage = error.name === "AbortError"
            ? "Save timed out. The server may have saved the change, but Banter could not confirm it. Keep Edit mode open and check the connection before retrying."
            : `Save failed: ${error.message}`;
        return false;
    }
}

// --------------------------------------------------
// Save phrase order
// --------------------------------------------------

async function savePhraseOrder() {
    // Nothing to save if no category is open.
    if (!activeCategory) {
        saveMessage = "No active category to save.";
        return false;
    }

    try {
        const response = await fetchWithTimeout("assets/save-phrases.php", {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
                "X-Banter-Token": window.BANTER_SAVE_TOKEN
            },

            // Send the category ID and phrase IDs in displayed order.
            // The server preserves the existing phrase text and IDs.
            body: JSON.stringify({
                categoryId: activeCategory.id,
                phraseIds: activePhrases.map(phrase => phrase.id)
            })
        });

        const result = await response.json();

        if (!response.ok || !result.ok) {
            throw new Error(result.error || `HTTP ${response.status}`);
        }

        await refreshCachedData([`data/${activeCategory.file}`]);
        return true;

    } catch (error) {
        console.error("Banter: phrase order save failed", error);
        saveMessage = error.name === "AbortError"
            ? "Save timed out. The server may have saved the change, but Banter could not confirm it. Keep Edit mode open and check the connection before retrying."
            : "Unable to save phrase order. Please try again.";
        return false;
    }
}



/*
 * Save the edited text of an existing phrase.
 *
 * The server updates the text while preserving the phrase's ID
 * and its position in the category's JSON file.
 */
async function savePhraseText(category, phraseId, text) {
    try {
        const response = await fetchWithTimeout("assets/save-phrase-txt.php", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Banter-Token": window.BANTER_SAVE_TOKEN
            },
            body: JSON.stringify({
                categoryId: category.id,
                phraseId: phraseId,
                text: text
            })
        });

        const result = await response.json();

        if (!response.ok || !result.ok) {
            throw new Error(result.error || `HTTP ${response.status}`);
        }

        await refreshCachedData([`data/${category.file}`]);
        return true;

    } catch (error) {
        console.error("Banter: phrase text save failed", error);
        return false;
    }
}




function setEditMode(enabled) {
    editMode = enabled;

    // Update the button to describe the action it will perform.
    editModeBtn.textContent = editMode
        ? "Finish editing"
        : "Edit mode";

    // CSS uses this class to change the appearance in Edit mode.
    document.body.classList.toggle("editing", editMode);

    // Rebuild whichever screen is currently open.
    if (currentScreen === "phrases" && activeCategory) {
        showPhrases(activeCategory);
    } else {
        showHome();
    }
}


/*
 * Discard only the unsaved reordering after a save failure.
 * The server and its saved JSON files are never changed by this action.
 */
function cancelOrderChanges() {
    if (currentScreen === "phrases" && activeCategory) {
        const phrasesById = new Map(
            activePhrases.map(phrase => [phrase.id, phrase])
        );

        activePhrases = originalPhraseOrder
            .map(id => phrasesById.get(id))
            .filter(Boolean);
    } else {
        const categoriesById = new Map(
            categories.map(category => [category.id, category])
        );

        const restoredCategories = originalCategoryOrder
            .map(id => categoriesById.get(id))
            .filter(Boolean);

        // Keep any category created during this editing session; adding a
        // category is already saved separately from its drag-and-drop order.
        const savedIds = new Set(restoredCategories.map(category => category.id));
        categories = restoredCategories.concat(
            categories.filter(category => !savedIds.has(category.id))
        );
    }

    saveMessage = "Unsaved order changes cancelled.";
    setEditMode(false);
}


editModeBtn.addEventListener("click", async () => {
    // Only enter Edit mode after the server responds; offline editing could
    // otherwise invite changes that cannot be saved.
    if (!editMode) {
        editModeBtn.disabled = true;
        editModeBtn.textContent = "Checking connection...";

        try {
            await checkServer(3000);
            saveMessage = "";

            // Remember the saved category order before drag-and-drop begins.
            originalCategoryOrder = categories.map(category => category.id);
            setEditMode(true);
        } catch (error) {
            console.warn("Banter: Edit mode requires a server connection.", error);
            window.alert(
                "Edit mode is unavailable because Banter could not reach the server. " +
                "Check your connection and try again."
            );
        } finally {
            editModeBtn.disabled = false;
            editModeBtn.textContent = editMode ? "Finish editing" : "Edit mode";
        }
        return;
    }

    // Remember which screen we are saving before changing modes.
    const savingPhrases = currentScreen === "phrases";

    // Prevent repeated clicks while the save is in progress.
    saveMessage = "";
    document.getElementById("saveStatus")?.remove();
    document.querySelector(".save-actions")?.remove();
    editModeBtn.disabled = true;
    editModeBtn.textContent = "Saving...";

    // Save the order belonging to the screen currently being edited.
    const saved = savingPhrases
        ? await savePhraseOrder()
        : await saveCategoryOrder();

    editModeBtn.disabled = false;


    if (saved) {
        // Keep the confirmation text locally while the screen is rebuilt.
        const confirmation = savingPhrases
            ? "Phrase order saved."
            : "Category order saved.";

        // Prevent showHome() from displaying the same message during redraw.
        saveMessage = "";

        // Return to performance mode on the same screen.
        setEditMode(false);

        // Display the confirmation once on the screen where the save occurred.
        const status = document.createElement("p");
        status.id = "saveStatus";
        status.setAttribute("role", "status");
        status.textContent = confirmation;
        
        
        if (savingPhrases) {
            // Keep the confirmation on the phrase screen, below Home.
            const homeButton = app.querySelector("button");
            if (homeButton) {
                app.insertBefore(status, homeButton.nextSibling);
            } else {
                app.prepend(status);
            }
        } else {
            // Category confirmations appear at the top of the home screen.
            app.prepend(status);
        }

        // The message has now been displayed; don't show it again on Home.
        saveMessage = "";
        
        
        
    } else {
        // Keep the shuffled order in memory until the user retries or cancels.
        // Do not rebuild the screen here: that could lose the user's changes.
        editModeBtn.textContent = "Finish editing";

        const status = document.createElement("p");
        status.id = "saveStatus";
        status.setAttribute("role", "alert");
        status.textContent = saveMessage;
        
// Keep the error directly below the Home button on the phrase screen,
// or at the very top of the category screen.
if (currentScreen === "phrases") {
    const homeButton = app.querySelector("button");
    if (homeButton) {
        app.insertBefore(status, homeButton.nextSibling);
    } else {
        app.prepend(status);
    }
} else {
    app.prepend(status);
}


        const actions = document.createElement("div");
        actions.className = "save-actions";

        const retryButton = document.createElement("button");
        retryButton.type = "button";
        retryButton.textContent = "Retry save";
        retryButton.addEventListener("click", () => {
            // Run the same guarded save flow as Finish editing.
            editModeBtn.click();
        });

        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.textContent = "Cancel changes";
        cancelButton.addEventListener("click", () => {
            cancelOrderChanges();
        });

        actions.append(retryButton, cancelButton);
        app.insertBefore(actions, status.nextSibling);
        
        // Bring the failed-save message and recovery buttons into view.
        window.scrollTo(0, 0);
    }
});


// --------------------------------------------------
// Category home screen
// --------------------------------------------------

function showHome() {
    // Never leave a pending countdown running after returning home.
    clearPhraseReturnTimer();
    // Remove the previous screen and any old category buttons.
    currentScreen = "home";
    app.replaceChildren();

    // Clear any previous SortableJS instance before rebuilding.
    // This prevents multiple sorting handlers being attached.
    if (categorySorter) {
        categorySorter.destroy();
        categorySorter = null;
    }

    // Show a heading appropriate to the current mode.
    const heading = document.createElement("h2");
    heading.textContent = editMode
        ? "Edit categories — drag to reorder"
        : "Choose a category";

    app.appendChild(heading);
    
    // Show the most recent save result, if there is one.
    if (saveMessage) {
        const message = document.createElement("p");
        message.textContent = saveMessage;
        message.setAttribute("role", "status");
        app.prepend(message);
                }

    // Put all category buttons inside one container.
    // SortableJS will use this container for drag-and-drop.
    const categoryList = document.createElement("div");
    categoryList.id = "categoryList";

    categories.forEach(category => {
        const button = document.createElement("button");

        button.type = "button";
        button.className = "category";
        button.textContent = category.name;
        
        // Keep the stable category ID on the button.
        // Sorting can then identify categories even if names change.
            button.dataset.categoryId = category.id;

        // Mark category buttons visually while editing.
        if (editMode) {
            button.classList.add("editable");
        }

        // In performance mode, tapping opens the category.
        // In Edit mode, tapping does nothing for now.
        button.addEventListener("click", () => {
            if (!editMode) {
                showPhrases(category);
            }
        });

        categoryList.appendChild(button);
    });

    app.appendChild(categoryList);
    
        // In Edit mode, offer a button to add a new category.
    if (editMode) {
        const addCategoryBtn = document.createElement("button");

        addCategoryBtn.type = "button";
        addCategoryBtn.textContent = "+ Add category";
        addCategoryBtn.id = "addCategoryBtn";

        addCategoryBtn.addEventListener("click", () => {
            showAddCategoryForm();
            });
        
        app.appendChild(addCategoryBtn);
    }

    // Enable drag-and-drop only while editing.
    // The SortableJS library is loaded separately by index.html.
    if (editMode && typeof Sortable !== "undefined") {
        categorySorter = Sortable.create(categoryList, {
            animation: 150,

            // Only allow the user to reorder category buttons.
            // The new order is copied back into our category data.
            onEnd: () => {
                const reorderedCategories = [];

                categoryList.querySelectorAll(".category").forEach(button => {
                    const category = categories.find(
                    item => item.id === button.dataset.categoryId
                        );
                    
                    if (category) {
                        reorderedCategories.push(category);
                    }
                });

                categories = reorderedCategories;

                // No file is saved at this stage.
                // The new order exists only in memory.
            }
        });
    }
}


/*
 * Display the form for adding a new category.
 * The server generates the category ID and phrase filename.
 */
function showAddCategoryForm() {
    // Remove the current screen.
    app.replaceChildren();

    // Form heading.
    const heading = document.createElement("h2");
    heading.textContent = "Add category";
    app.appendChild(heading);

    // Build the form.
    const form = document.createElement("form");
    form.id = "addCategoryForm";

    // Category name field.
    const nameLabel = document.createElement("label");
    nameLabel.htmlFor = "newCategoryName";
    nameLabel.textContent = "Category name";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.id = "newCategoryName";
    nameInput.name = "name";
    nameInput.maxLength = 100;
    nameInput.required = true;
    nameInput.autocomplete = "off";

    // Category description field.
    const descLabel = document.createElement("label");
    descLabel.htmlFor = "newCategoryDesc";
    descLabel.textContent = "Description";

    const descInput = document.createElement("input");
    descInput.type = "text";
    descInput.id = "newCategoryDesc";
    descInput.name = "desc";
    descInput.maxLength = 250;
    descInput.required = true;
    descInput.autocomplete = "off";

    // Submit button.
    const submitButton = document.createElement("button");
    submitButton.type = "submit";
    submitButton.textContent = "Create category";

    // Cancel button returns to the category list.
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => {
        saveMessage = "";
        showHome();
    });

    // Status/error messages appear here.
    const message = document.createElement("p");
    message.id = "addCategoryMessage";
    message.setAttribute("role", "status");

    // Assemble the form.
    form.append(
        nameLabel,
        nameInput,
        descLabel,
        descInput,
        submitButton,
        cancelButton,
        message
    );

    app.appendChild(form);

    
    // Submit the new category to the server.
    form.addEventListener("submit", async (event) => {
        // Keep the browser from navigating away from Banter.
        event.preventDefault();

        // Prevent duplicate submissions while the request is running.
        submitButton.disabled = true;
        cancelButton.disabled = true;
        submitButton.textContent = "Creating...";
        message.textContent = "";

        // Track whether the server created the category successfully.
        let categoryCreated = false;

        try {
            // Ask PHP to generate the category ID and filename.
            const response = await fetchWithTimeout("assets/save-new-category.php", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Banter-Token": window.BANTER_SAVE_TOKEN
                },
                body: JSON.stringify({
                    name: nameInput.value.trim(),
                    desc: descInput.value.trim()
                })
            });

            const result = await response.json();

            // Treat HTTP errors and PHP-reported errors as failures.
            if (!response.ok || !result.ok) {
                throw new Error(
                    result.error || `HTTP ${response.status}`
                );
            }

            categoryCreated = true;

            // Reload the authoritative category list from the server.
            const categoriesResponse = await fetchWithTimeout(
                "data/categories.json",
                {},
                8000
            );

            if (!categoriesResponse.ok) {
                throw new Error("Could not reload the category list");
            }

            const updatedCategories = await categoriesResponse.json();

            if (!Array.isArray(updatedCategories)) {
                throw new Error("The category list is invalid");
            }

            // Replace the in-memory list and cache the category list plus
            // every phrase file, including the new category's empty JSON.
            categories = updatedCategories;
            await refreshCachedData([
                "data/categories.json",
                ...updatedCategories.map(item => `data/${item.file}`)
            ]);

            // Return to the home screen, keeping Edit mode enabled.
            saveMessage = "Category added successfully.";
            showHome();

        } catch (error) {
            console.error("Banter: add category failed", error);

            if (categoryCreated) {
                // Avoid accidentally creating the same category twice.
                submitButton.disabled = true;
                submitButton.textContent = "Created — reload page";

                message.textContent =
                    "The category was created, but the list could not be refreshed. " +
                    "Reload the page before trying again.";
            } else {
                // Keep the form available so the user can retry.
                message.textContent = error.name === "AbortError"
                    ? "The request timed out. The category may have been created; check the category list before trying again."
                    : (error.message || "Could not create category. Please try again.");

                submitButton.disabled = false;
                cancelButton.disabled = false;
                submitButton.textContent = "Create category";
            }
        }
    });

    
    
    // Put the cursor in the first field.
    nameInput.focus();
}



// --------------------------------------------------
// Phrase screen
// --------------------------------------------------


async function showPhrases(category) {
    // Record whether this is a genuine move from Home to a category.
    // Redrawing an already-open category must not add history entries.
    const wasOnPhraseScreen = currentScreen === "phrases";

    currentScreen = "phrases";
    activeCategory = category;

    if (!wasOnPhraseScreen) {
        history.pushState(
            { banterScreen: "phrases" },
            "",
            location.href
        );
            }
            
            
    // Remove any previous phrase drag-and-drop instance.
    if (phraseSorter) {
        phraseSorter.destroy();
        phraseSorter = null;
    }

    // Remove the previous screen.
    app.replaceChildren();




    // Provide a way back to the category home screen.
    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.textContent = "← Home";

    backButton.addEventListener("click", () => {
        // Check whether the phrase order differs from the saved order
        // that was loaded when this category was opened.
        const orderChanged =
            activePhrases.length !== originalPhraseOrder.length ||
            activePhrases.some(
                (phrase, index) => phrase.id !== originalPhraseOrder[index]
            );

        // An unsaved text edit takes priority in the confirmation.
        if (editingPhraseId !== null) {
            const confirmed = window.confirm(
                "Discard your unsaved phrase changes and return home?"
            );

            if (!confirmed) {
                return;
            }

            editingPhraseId = null;
        } else if (editMode && orderChanged) {
            // Confirm if the phrase order has changed in Edit mode.
            const confirmed = window.confirm(
                "Discard your unsaved phrase order and return home?"
            );

            if (!confirmed) {
                return;
            }
        }

        showHome();
    });

    app.appendChild(backButton);
    
        
    // Show the category name as the heading.
    const heading = document.createElement("h2");
    heading.textContent = editMode
        ? `Edit: ${category.name}`
        : category.name;

    app.appendChild(heading);



       // Let the performer choose how long a phrase stays visible.
    // The preference is local to this device and works offline.
    if (!editMode) {
        const timerLabel = document.createElement("label");
        timerLabel.htmlFor = "phraseReturnDelay";
        timerLabel.textContent = "Home in ";

        const timerSelect = document.createElement("select");
        timerSelect.id = "phraseReturnDelay";
        timerSelect.setAttribute("aria-label", "Seconds before returning home");

/*        
        // Keep the timer control compact for small phone screens.
        // Zero means Off; the word "seconds" stays outside the dropdown.
        const timerOptions = Array.from({ length: 10 }, (_, i) => String(i));

        timerOptions.forEach(value => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            timerSelect.appendChild(option);
        });
*/
        
const timerOptions = [
    ["0", "0"],
    ...Array.from({ length: 9 }, (_, i) => [
        String(i + 1),
        String(i + 1)
    ])
];

        
        let savedDelay = "0";
        try {
            savedDelay = localStorage.getItem(PHRASE_DELAY_KEY) || "0";
        } catch (error) {
            console.warn("Banter: could not read phrase timer preference.", error);
        }

        // Build the choices and fall back safely if storage contains an invalid value.
        timerOptions.forEach(([label, value]) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            timerSelect.appendChild(option);
        });

        timerSelect.value = timerOptions.some(([, value]) => value === savedDelay)
            ? savedDelay
            : "0";

        timerSelect.addEventListener("change", () => {
            try {
                localStorage.setItem(PHRASE_DELAY_KEY, timerSelect.value);
            } catch (error) {
                console.warn("Banter: could not save phrase timer preference.", error);
            }
        });

        timerLabel.appendChild(timerSelect);

        const secondsText = document.createTextNode(" seconds");
        timerLabel.appendChild(secondsText);

        app.insertBefore(timerLabel, heading);
        
        
    } 
    

    
    try {
        // Each category stores its phrases in its own JSON file.
        const response = await fetchWithTimeout(
            `data/${category.file}`,
            {},
            8000
        );

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        // Keep a separate in-memory list so dragging can reorder it.
        activePhrases = await response.json();
        
        // Keep a separate copy so we can detect unsaved reordering.
        originalPhraseOrder = activePhrases.map(phrase => phrase.id);

        // Use a dedicated container for the phrase items.
        const phraseList = document.createElement("div");
        phraseList.id = "phraseList";

        activePhrases.forEach(phrase => {
            // The wrapper keeps the phrase and its edit controls together
            // when SortableJS changes the order.
            const phraseItem = document.createElement("div");
            phraseItem.className = "phrase-item";
            phraseItem.dataset.phraseId = phrase.id;

            // Create the phrase button.
            const button = document.createElement("button");
            button.type = "button";
            button.className = "phrase";
            button.textContent = phrase.text;

            if (editMode) {
                // Dashed styling identifies phrases that can be reordered.
                button.classList.add("editable");

            } else if (usedPhrases.has(phrase.id)) {
                // Used phrases are greyed out // and cannot be selected.
                button.classList.add("used");
                button.disabled = false;
            }

            // Keep the stable phrase ID attached to the button.
            button.dataset.phraseId = phrase.id;
            

button.addEventListener("click", () => {
    // Never mark phrases as used while editing.
    if (editMode) {
        return;
    }

    // Record the phrase immediately, even when the timer is enabled.
    usedPhrases.add(phrase.id);
    button.classList.add("used");

    const timerSelect = document.getElementById("phraseReturnDelay");
    const delaySeconds = Number(timerSelect?.value || 0);

    // Cancel any previous countdown so another tap gives fresh reading time.
    clearPhraseReturnTimer();

    if (delaySeconds === 0) {
        // Off preserves the original immediate-return behaviour.
        showHome();
        return;
    }

    // Leave the phrase screen visible while the countdown runs.
    phraseReturnTimer = window.setTimeout(() => {
        phraseReturnTimer = null;
        showHome();
    }, delaySeconds * 1000);
});

            phraseItem.appendChild(button);
            
            
            // Separate the phrase text from its editing controls.
            if (editMode) {
                const separator = document.createElement("hr");

                separator.style.width = "70%";
                separator.style.margin = "0.5rem auto";
                separator.style.border = "none";
                separator.style.borderTop = "1px solid var(--border)";

                phraseItem.appendChild(separator);
            }

            

            // Only show phrase editing controls in Edit mode.
            if (editMode) {
                // Open the text editor for this phrase.
                const editButton = document.createElement("button");
                editButton.type = "button";
                editButton.className = "edit-phrase";
                editButton.textContent = "✏️ Edit phrase";

                editButton.addEventListener("click", () => {
                    // Only one phrase editor may be open at a time.
                    if (editingPhraseId !== null) {
                        window.alert(
                            "Finish editing the current phrase first."
                        );
                        return;
                    }

                    editingPhraseId = phrase.id;

                    // Replace the phrase display with its editor.
                    const editor = document.createElement("div");
                    editor.className = "phrase-editor";

                    const textarea = document.createElement("textarea");
                    textarea.classList.add("phrase-editor");
                    textarea.className = "phrase-edit-text";
                    textarea.rows = 4;
                    textarea.maxLength = 2000;
                    textarea.value = phrase.text;
                    textarea.setAttribute(
                        "aria-label",
                        "Edit phrase text"
                    );

                    const status = document.createElement("p");
                    status.setAttribute("role", "status");

                    const saveButton = document.createElement("button");
                    saveButton.type = "button";
                    saveButton.textContent = "Save";

                    const cancelButton = document.createElement("button");
                    cancelButton.type = "button";
                    cancelButton.textContent = "Cancel";

                    // Save the edited text to the server.
                    saveButton.addEventListener("click", async () => {
                        const newText = textarea.value.trim();

                        if (!newText) {
                            status.textContent =
                                "Phrase text cannot be empty.";
                            textarea.focus();
                            return;
                        }

                        saveButton.disabled = true;
                        cancelButton.disabled = true;
                        status.textContent = "Saving...";

                        const saved = await savePhraseText(
                            category,
                            phrase.id,
                            newText
                        );

                        if (saved) {
                            editingPhraseId = null;

                            // Reload the authoritative phrase data.
                            await showPhrases(category);
                        } else {
                            status.textContent =
                                "Unable to confirm the save. Your text is still here. Check the connection before retrying.";

                            saveButton.disabled = false;
                            cancelButton.disabled = false;
                        }
                    });

                    // Discard changes and restore the original phrase.
                    cancelButton.addEventListener("click", () => {
                        editingPhraseId = null;
                        showPhrases(category);
                    });

                    editor.appendChild(textarea);
                    editor.appendChild(status);
                    editor.appendChild(saveButton);
                    editor.appendChild(cancelButton);

                    // Hide the normal phrase display while editing.
                    button.hidden = true;
                    editButton.hidden = true;

                    // Put the editor immediately after the phrase button.
                    phraseItem.insertBefore(editor, editButton);

                    textarea.focus();
                });

                phraseItem.appendChild(editButton);

                // Delete this phrase after confirmation.
                const deleteButton = document.createElement("button");
                deleteButton.type = "button";
                deleteButton.className = "delete-phrase";
                deleteButton.textContent = "🗑 Delete phrase";
                deleteButton.setAttribute(
                    "aria-label",
                    `Delete phrase: ${phrase.text}`
                );

                deleteButton.addEventListener("click", async () => {
                    if (editingPhraseId !== null) {
                        window.alert(
                            "Finish editing the current phrase first."
                        );
                        return;
                    }

                    const confirmed = window.confirm(
                        `Delete this phrase?\n\n"${phrase.text}"\n\n` +
                        "This cannot be undone."
                    );

                    if (!confirmed) {
                        return;
                    }

                    deleteButton.disabled = true;
                    deleteButton.textContent = "Deleting...";

                    try {
                        const deleteResponse = await fetchWithTimeout(
                            "assets/delete-phrase.php",
                            {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json",
                                    "X-Banter-Token": window.BANTER_SAVE_TOKEN
                                },
                                body: JSON.stringify({
                                    categoryId: category.id,
                                    phraseId: phrase.id
                                })
                            }
                        );

                        const result = await deleteResponse.json();

                        if (!deleteResponse.ok || !result.ok) {
                            throw new Error(
                                result.error || `HTTP ${deleteResponse.status}`
                            );
                        }

                        usedPhrases.delete(phrase.id);
                        await refreshCachedData([`data/${category.file}`]);
                        await showPhrases(category);

                    } catch (error) {
                        console.error(
                            "Banter: phrase deletion failed",
                            error
                        );

                        window.alert(
                            "Unable to delete the phrase. Please try again."
                        );

                        deleteButton.disabled = false;
                        deleteButton.textContent = "🗑 Delete phrase";
                    }
                });

                phraseItem.appendChild(deleteButton);
            }
            
            phraseList.appendChild(phraseItem);
        });

        app.appendChild(phraseList);

        // In Edit mode, offer a button to add a new phrase.
        if (editMode) {
            const addPhraseBtn = document.createElement("button");

            addPhraseBtn.type = "button";
            addPhraseBtn.textContent = "+ Add phrase";
            addPhraseBtn.id = "addPhraseBtn";

            addPhraseBtn.addEventListener("click", () => {
                // Open the draft editor for this category.
                showNewPhraseForm(category);
            });

            app.appendChild(addPhraseBtn);
        }

        // Drag whole phrase items so each delete button stays with its phrase.
        if (editMode && typeof Sortable !== "undefined") {
            phraseSorter = Sortable.create(phraseList, {
                animation: 150,
                draggable: ".phrase-item",

                // Copy the new displayed order into our in-memory phrase list.
                onEnd: () => {
                    const reorderedPhrases = [];

                    phraseList.querySelectorAll(".phrase-item").forEach(item => {
                        const phrase = activePhrases.find(
                            entry => entry.id === item.dataset.phraseId
                        );

                        if (phrase) {
                            reorderedPhrases.push(phrase);
                        }
                    });

                    activePhrases = reorderedPhrases;

                    // Finish editing saves this new order.
                }
            });
        }

    } catch (error) {
        console.error("Banter:", error);

        const message = document.createElement("p");
        message.textContent =
            "Unable to load phrases. Check the category's JSON file.";

        app.appendChild(message);
    }
}

// Handle the phone/browser Back button while viewing phrases.
window.addEventListener("popstate", () => {
    if (currentScreen === "phrases") {
        showHome();
    }
});


/*
 * Show the editor for a new phrase.
 *
 * The phrase remains a draft until Save phrase is pressed.
 * Discard phrase simply returns to the category's phrase list.
 */
function showNewPhraseForm(category) {
    // Remember which category and screen are active.
    currentScreen = "phrases";
    activeCategory = category;

    // Remove the existing screen before building the editor.
    app.replaceChildren();

    // Keep the category heading visible.
    const heading = document.createElement("h2");
    heading.textContent = category.name;
    app.appendChild(heading);

    // Explain what the user is editing.
    const label = document.createElement("label");
    heading.classList.add("new-phrase-label");
    label.htmlFor = "newPhraseText";
    label.textContent = "New phrase";
    app.appendChild(label);

    // The draft is not sent to the server until it is saved.
    const textarea = document.createElement("textarea");
    textarea.classList.add("phrase-edit-text");
    textarea.id = "newPhraseText";
    textarea.rows = 5;
    textarea.maxLength = 2000;
    textarea.placeholder = "Type the new phrase here...";
    textarea.setAttribute("aria-label", "New phrase text");
    app.appendChild(textarea);

    // Display messages here without leaving the editor.
    const status = document.createElement("p");
    status.id = "newPhraseStatus";
    status.setAttribute("role", "status");
    app.appendChild(status);

    // Save the phrase to the server.
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save phrase";

    saveBtn.addEventListener("click", async () => {
        const phraseText = textarea.value.trim();

        if (!phraseText) {
            status.textContent = "Please enter some phrase text first.";
            textarea.focus();
            return;
        }

        // Prevent duplicate submissions while the save is in progress.
        saveBtn.disabled = true;
        discardBtn.disabled = true;
        status.textContent = "Saving phrase...";

        try {
            const response = await fetchWithTimeout("assets/save-new-phrase.php", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Banter-Token": window.BANTER_SAVE_TOKEN
                },
                body: JSON.stringify({
                    categoryId: category.id,
                    text: phraseText
                })
            });

            const result = await response.json();

            if (!response.ok || !result.ok) {
                throw new Error(
                    result.error || `HTTP ${response.status}`
                );
            }

            // Refresh offline copies, then reload the saved phrase list.
            await refreshCachedData([`data/${category.file}`]);
            await showPhrases(category);

        } catch (error) {
            console.error("Banter: new phrase save failed", error);

            status.textContent = error.name === "AbortError"
                ? "The request timed out. The phrase may have been saved; check the category before retrying to avoid a duplicate."
                : "Unable to save the phrase. Please try again.";

            saveBtn.disabled = false;
            discardBtn.disabled = false;
        }
    });

    app.appendChild(saveBtn);

    // Discard the unsaved draft without changing the JSON file.
    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.textContent = "Discard phrase";

    discardBtn.addEventListener("click", () => {
        showPhrases(category);
    });

    app.appendChild(discardBtn);

    // Put the cursor in the new editor immediately.
    textarea.focus();
}



// --------------------------------------------------
// Start the application
// --------------------------------------------------

// Wait until the HTML document has loaded before reading
// its elements and loading the category data.
document.addEventListener("DOMContentLoaded", () => {
    loadTheme();
    startMaintenanceTimer();

    // Check connectivity in the background; never delay cached startup.
    checkServer(3000).catch(() => {
        console.info("Banter: starting with available cached data.");
    });

    loadCategories();
});
