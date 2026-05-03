import os
from dotenv import load_dotenv
load_dotenv()

tables = {
    "assets":    os.environ.get("TABLE_ASSETS",     "Assets"),
    "products":  os.environ.get("TABLE_PRODUCTS",   "Product"),
    "tasks":     os.environ.get("TABLE_TASKS",      "Tasking"),
    "templates": os.environ.get("TABLE_TEMPLATES",  "Task Templates"),
    "itemTypes": os.environ.get("TABLE_ITEM_TYPES", "Item Types"),
}
