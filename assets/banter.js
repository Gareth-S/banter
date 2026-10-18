
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
// Phrase editing state
// --------------------------------------------------

// The category currently open on the phrase screen.
let activeCategory = null;

// The phrases currently displayed, in their current order.
let activePhrases = [];

// Reference to the active phrase drag-and-drop instance.
let phraseSorter = null;


// Which screen is currently displayed: "home" or "phrases".
let currentScreen = "home";


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
        const response = await fetch("assets/save-phrases.php", {
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

        return true;

    } catch (error) {
        console.error("Banter: phrase order save failed", error);
        saveMessage = "Unable to save phrase order. Please try again.";
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


// Entering Edit mode is immediate.
// Saving when leaving Edit mode will be added in the next step.


editModeBtn.addEventListener("click", async () => {
    // Entering Edit mode is immediate; nothing needs saving yet.
    if (!editMode) {
        saveMessage = "";
        setEditMode(true);
        return;
    }

    // Remember which screen we are saving before changing modes.
    const savingPhrases = currentScreen === "phrases";

    // Prevent repeated clicks while the save is in progress.
    editModeBtn.disabled = true;
    editModeBtn.textContent = "Saving...";

    // Save the order belonging to the screen currently being edited.
    const saved = savingPhrases
        ? await savePhraseOrder()
        : await saveCategoryOrder();

    editModeBtn.disabled = false;

    if (saved) {
        // Report which order was saved successfully.
        saveMessage = savingPhrases
            ? "Phrase order saved."
            : "Category order saved.";

        // Return to performance mode on the same screen.
        setEditMode(false);
    } else {
        // Keep Edit mode and the current order if saving fails.
        setEditMode(true);
    }
});


// --------------------------------------------------
// Category home screen
// --------------------------------------------------

function showHome() {
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
            const response = await fetch("assets/save-new-category.php", {
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
            const categoriesResponse = await fetch("data/categories.json", {
                cache: "no-store"
            });

            if (!categoriesResponse.ok) {
                throw new Error("Could not reload the category list");
            }

            const updatedCategories = await categoriesResponse.json();

            if (!Array.isArray(updatedCategories)) {
                throw new Error("The category list is invalid");
            }

            // Replace the in-memory list with the updated list.
            categories = updatedCategories;

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
                message.textContent =
                    error.message || "Could not create category. Please try again.";

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
    // Remember which category is open.
    currentScreen = "phrases";
    activeCategory = category;

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

        // Keep a separate in-memory list so dragging can reorder it.
        activePhrases = await response.json();

        // Use a dedicated container for the phrase buttons.
        const phraseList = document.createElement("div");
        phraseList.id = "phraseList";

        activePhrases.forEach(phrase => {
            const button = document.createElement("button");

            button.type = "button";
            button.className = "phrase";
            button.textContent = phrase.text;

            if (editMode) {
                // Dashed styling identifies phrases that can be reordered.
                button.classList.add("editable");

            } else if (usedPhrases.has(phrase.id)) {
                // Used phrases are greyed out and cannot be selected.
                button.classList.add("used");
                button.disabled = true;
            }

            // Keep each phrase's stable ID attached to its button.
            button.dataset.phraseId = phrase.id;

            button.addEventListener("click", () => {
                // Never mark phrases as used while editing.
                if (editMode) {
                    return;
                }

                // Record the phrase as used and return home.
                usedPhrases.add(phrase.id);
                showHome();
            });

            phraseList.appendChild(button);
        });

        app.appendChild(phraseList);

        // Dragging is enabled only while editing.
        if (editMode && typeof Sortable !== "undefined") {
            phraseSorter = Sortable.create(phraseList, {
                animation: 150,

                // Do not drag disabled buttons or buttons that aren't editable.
                draggable: ".phrase.editable",

                // Copy the new displayed order into our in-memory phrase list.
                onEnd: () => {
                    const reorderedPhrases = [];

                    phraseList.querySelectorAll(".phrase").forEach(button => {
                        const phrase = activePhrases.find(
                            item => item.id === button.dataset.phraseId
                        );

                        if (phrase) {
                            reorderedPhrases.push(phrase);
                        }
                    });

                    activePhrases = reorderedPhrases;

                    // Saving will be connected in the next step.
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



// --------------------------------------------------
// Start the application
// --------------------------------------------------

// Wait until the HTML document has loaded before reading
// its elements and loading the category data.
document.addEventListener("DOMContentLoaded", loadCategories);
