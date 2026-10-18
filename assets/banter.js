
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

// Main page elements, defined in index.html.
const app = document.getElementById("app");
const editModeBtn = document.getElementById("editModeBtn");

// Displays save success or failure messages to the user.
let saveMessage = "";

// Data loaded from JSON and the current interface mode.
let categories = [];
let editMode = false;

// Reference to the active SortableJS instance.
// Keeping this lets us destroy it when leaving Edit mode.
let categorySorter = null;


// --------------------------------------------------
// Load category data
// --------------------------------------------------

async function loadCategories() {
    try {
        // Read the category list from the JSON file.
//        const response = await fetch("data/categories.json");

        // Category order can change during editing, so always request
        // the latest saved version rather than relying on browser cache.
            const response = await fetch("data/categories.json", {
            cache: "no-store"
            });
        
        
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
        const response = await fetch("assets/save-categories.php", {
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

        return true;

    } catch (error) {
        console.error("Banter: unable to save category order", error);

        saveMessage = `Save failed: ${error.message}`;
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

    // Rebuild the home screen to match the selected mode.
    showHome();
}

// Entering Edit mode is immediate.
// Saving when leaving Edit mode will be added in the next step.

editModeBtn.addEventListener("click", async () => {
    // Entering Edit mode does not require a save.
    if (!editMode) {
        saveMessage = "";
        setEditMode(true);
        return;
    }

    // Prevent repeated clicks while the save is in progress.
    editModeBtn.disabled = true;
    editModeBtn.textContent = "Saving...";

    const saved = await saveCategoryOrder();

    editModeBtn.disabled = false;

    if (saved) {
        // A successful save commits the new order.
        saveMessage = "Category order saved.";
        setEditMode(false);
    } else {
        // A failed save keeps the reordered list and Edit mode.
        setEditMode(true);
    }
});


// --------------------------------------------------
// Category home screen
// --------------------------------------------------

function showHome() {
    // Remove the previous screen and any old category buttons.
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
        app.appendChild(message);
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


// --------------------------------------------------
// Phrase screen
// --------------------------------------------------

async function showPhrases(category) {
    // Remove the category screen.
    app.replaceChildren();

    // Provide a way back to the category home screen.
    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.textContent = "← Home";
    backButton.addEventListener("click", showHome);

    app.appendChild(backButton);

    // Show the category name as the heading.
    const heading = document.createElement("h2");
    heading.textContent = editMode
        ? `Edit: ${category.name}`
        : category.name;

    app.appendChild(heading);

    try {
        // Each category stores its phrases in its own JSON file.
        const response = await fetch(`data/${category.file}`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const phrases = await response.json();

        phrases.forEach(phrase => {
            const button = document.createElement("button");

            button.type = "button";
            button.className = "phrase";
            button.textContent = phrase.text;

            if (editMode) {
                // Styling only for now; phrase editing comes later.
                button.classList.add("editable");

            } else if (usedPhrases.has(phrase.id)) {
                // Used phrases are greyed out and cannot be selected.
                button.classList.add("used");
                button.disabled = true;
            }

            button.addEventListener("click", () => {
                // Never mark phrases as used while editing.
                if (editMode) {
                    return;
                }

                // Record the phrase as used and return home.
                usedPhrases.add(phrase.id);
                showHome();
            });

            app.appendChild(button);
        });

    } catch (error) {
        console.error("Banter:", error);

        const message = document.createElement("p");
        message.textContent =
            "Unable to load phrases. Check the category's JSON file.";

        app.appendChild(message);
    }
}


// --------------------------------------------------
// Start the application
// --------------------------------------------------

// Wait until the HTML document has loaded before reading
// its elements and loading the category data.
document.addEventListener("DOMContentLoaded", loadCategories);
