const vscode = require("vscode");

/**
 * Cache for decoration types to avoid recreating them
 */
let decorationTypesCache = [];

/**
 * Track active editor
 */
let activeEditor = undefined;

/**
 * Track if the extension is enabled
 */
let isEnabled = true;

/**
 * Track timeout for debouncing updates
 */
let timeout = undefined;

/**
 * Track the current configuration
 */
let config = {
  colors: [],
  startPatterns: [],
  endPatterns: [],
  excludedLanguages: [],
  includeStartEndLines: false,
};

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log("Comment Block Highlighter activated"); // DEBUG: 🔬 for debugging purpose

  // INFO: ℹ️ Load configuration
  loadConfiguration();

  // Set initial active editor
  activeEditor = vscode.window.activeTextEditor;

  // INFO: ℹ️ Register the toggle command
  // command that users can trigger through Command Palette (Ctrl+Shift+P)
  const toggleCommand = vscode.commands.registerCommand(
    "comment-block-highlighter.toggle",
    () => {
      isEnabled = !isEnabled;
      vscode.window.showInformationMessage(
        `Comment Block Highlighting ${isEnabled ? "enabled" : "disabled"}`
      );

      if (isEnabled) {
        updateDecorations();
      } else {
        clearDecorations();
      }
    }
  );

  // INFO: ℹ️ Register configuration change listener
  // Watches for changes to the extension's settings in VS Code settings.json
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("commentBlockHighlighter")) {
        loadConfiguration();
        if (isEnabled) {
          updateDecorations();
        }
      }
    })
  );

  // INFO: ℹ️ Register editor change listener
  // Updating decorations when switching between files
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      activeEditor = editor;
      if (isEnabled && editor) {
        triggerUpdateDecorations();
      }
    })
  );

  // INFO: ℹ️ Register document change listener
  // This event listener detects when users modify content in real-time
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (
        isEnabled &&
        activeEditor &&
        event.document === activeEditor.document
      ) {
        triggerUpdateDecorations();
      }
    })
  );

  // Register the toggle command in context
  context.subscriptions.push(toggleCommand);

  // PERFORMANCE: ⏱️ Initial update if there's an active editor
  // Ensure highlighting is applied immediately on startup (crucial for UX)
  if (activeEditor && isEnabled) {
    triggerUpdateDecorations();
  }
}

/**
 * Load configuration from VS Code settings
 */
function loadConfiguration() {
  const configObj = vscode.workspace.getConfiguration(
    "commentBlockHighlighter"
  );

  // WHAT THIS DO: ⁉️ Get configuration values
  isEnabled = configObj.get("enabled", true);
  config.colors = configObj.get("colors", [
    "rgba(255, 255, 64, 0.07)",
    "rgba(127, 255, 127, 0.07)",
    "rgba(255, 127, 255, 0.07)",
    "rgba(79, 236, 236, 0.07)",
  ]);
  config.startPatterns = configObj.get("startPatterns", [
    "^\\s*#\\s*(?:start|region|begin)",
    "^\\s*//\\s*(?:start|region|begin)",
  ]);
  config.endPatterns = configObj.get("endPatterns", [
    "^\\s*#\\s*(?:end|endregion)",
    "^\\s*//\\s*(?:end|endregion)",
  ]);

  // Store language-specific patterns
  config.languagePatterns = configObj.get("languagePatterns", {});

  config.excludedLanguages = configObj.get("excludedLanguages", []);
  config.includeStartEndLines = configObj.get("includeStartEndLines", false);

  // NEXT STEP: ➡️ Create decoration types based on colors
  createDecorationTypes();
}

/**
 * Get language-specific patterns for the current document
 */
function getPatternsForLanguage(languageId) {
  // Default patterns
  let startPatterns = [...config.startPatterns];
  let endPatterns = [...config.endPatterns];

  // Check if we have language-specific patterns
  for (const langGroup in config.languagePatterns) {
    if (langGroup.split(",").includes(languageId)) {
      const langPatterns = config.languagePatterns[langGroup];
      if (langPatterns.startPatterns) {
        startPatterns = langPatterns.startPatterns;
      }
      if (langPatterns.endPatterns) {
        endPatterns = langPatterns.endPatterns;
      }
      break; // Found a match, no need to check others
    }
  }

  return { startPatterns, endPatterns };
}

/**
 * Create decoration types based on colors from configuration
 */
function createDecorationTypes() {
  // NOTE: 📝 Dispose old decoration types if they exist
  if (decorationTypesCache.length > 0) {
    decorationTypesCache.forEach((dec) => dec.dispose());
    decorationTypesCache = [];
  }

  // INFO: ℹ️ Create new decoration types
  config.colors.forEach((color) => {
    decorationTypesCache.push(
      vscode.window.createTextEditorDecorationType({
        backgroundColor: color,
        isWholeLine: true,
      })
    );
  });
}

/**
 * Trigger debounced update of decorations
 */
function triggerUpdateDecorations() {
  if (timeout) {
    clearTimeout(timeout);
    timeout = undefined;
  }
  timeout = setTimeout(updateDecorations, 300);
} // WHAT THIS DO: ⁉️ Creates a 300ms "cooling period" before applying decorations

/**
 * Clear all decorations
 */
function clearDecorations() {
  if (!activeEditor) return;

  decorationTypesCache.forEach((decorationType) => {
    activeEditor.setDecorations(decorationType, []);
  });
} // WHAT THIS DO: ⁉️ Efficiently removes all decorations by passing an empty array to setDecorations()

/**
 * Update decorations in the active editor
 */
function updateDecorations() {
  if (!activeEditor || !isEnabled) {
    return;
  }

  // NOTE: 📝 Check if the language is excluded
  if (config.excludedLanguages.includes(activeEditor.document.languageId)) {
    clearDecorations();
    return;
  }

  const text = activeEditor.document.getText();
  const lines = text.split("\n");

  // NOTE: 📝 Get language-specific patterns
  getPatternsForLanguage(activeEditor.document.languageId);

  // NOTE: 📝 Convert string patterns to RegExp objects
  const startRegexes = config.startPatterns.map(
    (pattern) => new RegExp(pattern)
  );
  const endRegexes = config.endPatterns.map((pattern) => new RegExp(pattern));

  // Arrays to store ranges for different levels
  const rangesByLevel = Array(decorationTypesCache.length)
    .fill()
    .map(() => []);

  // INFO: ℹ️ Process the document to find blocks
  // WHAT THIS DO: ⁉️ The algorithm uses a stack data structure to handle nested regions
  let blockStack = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // INFO: ℹ️ Check if line matches start pattern
    const isStartLine = startRegexes.some((regex) => regex.test(line));

    if (isStartLine) {
      blockStack.push({
        startLine: i,
        level: blockStack.length % decorationTypesCache.length,
      });
    }

    // INFO: ℹ️ Check if line matches end pattern
    const isEndLine = endRegexes.some((regex) => regex.test(line));

    if (isEndLine && blockStack.length > 0) {
      const block = blockStack.pop();

      // Create decoration range
      const startLineNum = config.includeStartEndLines
        ? block.startLine
        : block.startLine + 1;
      const endLineNum = config.includeStartEndLines ? i : i - 1;

      // Only create range if there's actually content to highlight
      if (startLineNum <= endLineNum) {
        const range = new vscode.Range(
          startLineNum,
          0,
          endLineNum,
          lines[endLineNum].length
        );

        rangesByLevel[block.level].push(range);
      }
    }
  }

  // INFO: ℹ️ Apply decorations by level
  decorationTypesCache.forEach((decorationType, index) => {
    activeEditor.setDecorations(decorationType, rangesByLevel[index]);
  });
}

/**
 * Called when the extension is deactivated
 */
function deactivate() {
  // Clean up decorations
  clearDecorations();

  // Dispose decoration types
  if (decorationTypesCache.length > 0) {
    decorationTypesCache.forEach((dec) => dec.dispose());
    decorationTypesCache = [];
  }
}

module.exports = {
  activate,
  deactivate,
};
