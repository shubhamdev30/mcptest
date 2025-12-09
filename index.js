import readline from "readline";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { sendResponse, sendError } from "./src/messages.js";

dotenv.config();

// Create readline interface for stdin/stdout communication
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

let buffer = "";

// Use environment variables if present, otherwise fallback to hardcoded values.
// It's strongly recommended to set SHOPIFY_TOKEN and SHOPIFY_DOMAIN in your .env for production.
const SHOPIFY_TOKEN =process.env.SHOPIFY_TOKEN || "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";
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || "shubhamneema123.myshopify.com";
const SHOPIFY_GRAPHQL_URL = `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/graphql.json`;

rl.on("line", async (line) => {
  buffer += line;

  try {
    const msg = JSON.parse(buffer);
    buffer = ""; // Clear buffer after successful parse

    console.error(`[MCP Server] Received: ${msg.method}`);

    // Handle notifications (no response expected)
    if (msg.id === undefined) {
      console.error(`[MCP Server] Processing notification: ${msg.method}`);
      return;
    }

    // Handle different MCP methods
    try {
      let response;

      switch (msg.method) {
        case "initialize":
          response = {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {
                tools: {},
              },
              serverInfo: {
                name: "shopify-mcp",
                version: "1.0.0",
              },
            },
          };
          break;

        case "tools/list":
          response = {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: [
                {
                  name: "get-products-count",
                  description:
                    "Retrieves total products count from the Shopify store",
                  inputSchema: {
                    type: "object",
                    properties: {},
                    required: [],
                  },
                },
                {
                  name: "delete-product-by-name",
                  description:
                    "Finds a product by exact title and deletes it. Expects arguments: { productName: string }",
                  inputSchema: {
                    type: "object",
                    properties: {
                      productName: {
                        type: "string",
                        description: "Exact product title to delete",
                      },
                    },
                    required: ["productName"],
                  },
                },
                {
                  name: "update-order-address",
                  description:
                    "Update an order's shipping and/or billing address. Accepts { orderId?: string (GID), orderName?: string (e.g. '#1001'), updates: { shippingAddress?: {...}, billingAddress?: {...} } }",
                  inputSchema: {
                    type: "object",
                    properties: {
                      orderId: { type: "string" },
                      orderName: { type: "string" },
                      updates: {
                        type: "object",
                        properties: {
                          shippingAddress: { type: "object" },
                          billingAddress: { type: "object" },
                        },
                      },
                    },
                    required: ["updates"],
                  },
                },
              ],
            },
          };
          break;

        case "tools/call":
          const { name, arguments: args } = msg.params;
          console.error(
            `[MCP Server] Tool call: ${name} with args:`,
            JSON.stringify(args)
          );

          if (name === "get-products-count") {
            const gqlQuery = `
              {
                productsCount {
                  count
                }
              }
            `;

            const res = await fetch(SHOPIFY_GRAPHQL_URL, {
              method: "POST",
              headers: {
                "X-Shopify-Access-Token": SHOPIFY_TOKEN,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ query: gqlQuery }),
            });

            const data = await res.json();

            console.error(`[MCP Server] Tool result:`, JSON.stringify(data));

            response = {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(data, null, 2),
                  },
                ],
              },
            };
          } else if (name === "delete-product-by-name") {
            // Expect args to contain productName
            const productName =
              args && (args.productName || args.name || args.product);
            if (!productName || typeof productName !== "string") {
              sendError(
                msg.id,
                -32602,
                `Invalid arguments. Expected { productName: string }`
              );
              return;
            }

            // Escape double quotes for safe embedding in query string
            const safeName = productName.replace(/"/g, '\\"');

            // 1) Find product by exact title using products query with a title search
            const findQuery = `
              {
                products(first: 1, query: "title:'${safeName}'") {
                  edges {
                    node {
                      id
                      title
                      handle
                    }
                  }
                }
              }
            `;

            const findRes = await fetch(SHOPIFY_GRAPHQL_URL, {
              method: "POST",
              headers: {
                "X-Shopify-Access-Token": SHOPIFY_TOKEN,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ query: findQuery }),
            });

            const findData = await findRes.json();
            console.error(
              `[MCP Server] Find product response:`,
              JSON.stringify(findData)
            );

            // Check for errors in find response
            if (findData.errors && findData.errors.length > 0) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `Error searching for product: ${JSON.stringify(
                        findData.errors,
                        null,
                        2
                      )}`,
                    },
                  ],
                },
              };
              break;
            }

            const edges = findData?.data?.products?.edges || [];
            if (edges.length === 0) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `No product found with title exactly matching "${productName}".`,
                    },
                  ],
                },
              };
              break;
            }

            const productNode = edges[0].node;
            const productId = productNode.id;

            console.error(
              `[MCP Server] Found product ID: ${productId} title: ${productNode.title}`
            );

            // 2) Delete product with productDelete mutation
            const deleteMutation = `
              mutation productDelete($id: ID!) {
                productDelete(input: { id: $id }) {
                  deletedProductId
                  userErrors {
                    field
                    message
                  }
                }
              }
            `;

            const deleteRes = await fetch(SHOPIFY_GRAPHQL_URL, {
              method: "POST",
              headers: {
                "X-Shopify-Access-Token": SHOPIFY_TOKEN,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ query: deleteMutation, variables: { id: productId } }),
            });

            const deleteData = await deleteRes.json();
            console.error(
              `[MCP Server] Delete response:`,
              JSON.stringify(deleteData)
            );

            // Prepare a friendly message for the MCP client
            let text;
            if (deleteData?.data?.productDelete?.userErrors?.length) {
              text = `Failed to delete product "${productNode.title}" (ID: ${productId}). Errors: ${JSON.stringify(
                deleteData.data.productDelete.userErrors,
                null,
                2
              )}`;
            } else if (deleteData?.data?.productDelete?.deletedProductId) {
              text = `Product deleted successfully.\nTitle: ${productNode.title}\nDeleted ID: ${deleteData.data.productDelete.deletedProductId}`;
            } else {
              // Fallback to raw response
              text = `Delete response: ${JSON.stringify(deleteData, null, 2)}`;
            }

            response = {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                content: [
                  {
                    type: "text",
                    text,
                  },
                ],
              },
            };
          } else if (name === "update-order-address") {
            // Expected args: { orderId?: string, orderName?: string, updates: { shippingAddress?: {...}, billingAddress?: {...} } }
            const orderId = args && args.orderId;
            const orderName = args && args.orderName;
            const updates = args && args.updates;

            if (!updates || typeof updates !== "object") {
              sendError(
                msg.id,
                -32602,
                `Invalid arguments. Expected { updates: { shippingAddress?: {...}, billingAddress?: {...} }, orderId?: string, orderName?: string }`
              );
              return;
            }

            // Helper to find order by orderName (human readable name like "#1001")
            async function findOrderIdByName(name) {
              const safeName = name.replace(/"/g, '\\"'); // escape
              const findOrderQuery = `
                {
                  orders(first:1, query: "name:'${safeName}'") {
                    edges {
                      node {
                        id
                        name
                      }
                    }
                  }
                }
              `;
              const findOrderRes = await fetch(SHOPIFY_GRAPHQL_URL, {
                method: "POST",
                headers: {
                  "X-Shopify-Access-Token": SHOPIFY_TOKEN,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ query: findOrderQuery }),
              });

              const findOrderData = await findOrderRes.json();
              console.error(
                `[MCP Server] Find order response:`,
                JSON.stringify(findOrderData)
              );

              if (findOrderData.errors && findOrderData.errors.length > 0) {
                throw new Error(
                  `Error searching for order: ${JSON.stringify(findOrderData.errors)}`
                );
              }

              const edges = findOrderData?.data?.orders?.edges || [];
              if (edges.length === 0) return null;
              return edges[0].node.id;
            }

            // Determine the GID order id to use in mutation
            let targetOrderId = orderId;
            if (!targetOrderId && orderName) {
              try {
                targetOrderId = await findOrderIdByName(orderName);
                if (!targetOrderId) {
                  response = {
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                      content: [
                        {
                          type: "text",
                          text: `No order found with name exactly matching "${orderName}".`,
                        },
                      ],
                    },
                  };
                  break;
                }
              } catch (err) {
                console.error("[MCP Server] Error finding order by name:", err);
                response = {
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: `Error searching for order: ${err.message}`,
                      },
                    ],
                  },
                };
                break;
              }
            }

            if (!targetOrderId) {
              sendError(
                msg.id,
                -32602,
                `Missing order identifier. Provide either orderId (GID) or orderName.`
              );
              return;
            }

            // Build the input object for the mutation.
            // We only include shippingAddress/billingAddress when provided.
            const input = { id: targetOrderId };
            if (updates.shippingAddress && typeof updates.shippingAddress === "object") {
              input.shippingAddress = updates.shippingAddress;
            }
            if (updates.billingAddress && typeof updates.billingAddress === "object") {
              input.billingAddress = updates.billingAddress;
            }

            // If no address fields were provided, return error
            if (!input.shippingAddress && !input.billingAddress) {
              sendError(
                msg.id,
                -32602,
                `No address fields provided in updates. Provide shippingAddress and/or billingAddress.`
              );
              return;
            }

            // orderUpdate mutation using variables
            const orderUpdateMutation = `
              mutation orderUpdate($input: OrderInput!) {
                orderUpdate(input: $input) {
                  order {
                    id
                    name
                    shippingAddress {
                      firstName
                      lastName
                      address1
                      address2
                      city
                      province
                      country
                      zip
                      phone
                    }
                    billingAddress {
                      firstName
                      lastName
                      address1
                      address2
                      city
                      province
                      country
                      zip
                      phone
                    }
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }
            `;

            const updateRes = await fetch(SHOPIFY_GRAPHQL_URL, {
              method: "POST",
              headers: {
                "X-Shopify-Access-Token": SHOPIFY_TOKEN,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                query: orderUpdateMutation,
                variables: { input },
              }),
            });

            const updateData = await updateRes.json();
            console.error(
              `[MCP Server] orderUpdate response:`,
              JSON.stringify(updateData)
            );

            // Prepare response text
            let text;
            const userErrors = updateData?.data?.orderUpdate?.userErrors || [];
            const updatedOrder = updateData?.data?.orderUpdate?.order || null;

            if (userErrors.length > 0) {
              text = `Failed to update order ${targetOrderId}. Errors: ${JSON.stringify(
                userErrors,
                null,
                2
              )}`;
            } else if (updatedOrder) {
              text = `Order updated successfully.\nOrder: ${updatedOrder.name || updatedOrder.id}\nUpdated shippingAddress: ${JSON.stringify(
                updatedOrder.shippingAddress,
                null,
                2
              )}\nUpdated billingAddress: ${JSON.stringify(
                updatedOrder.billingAddress,
                null,
                2
              )}`;
            } else {
              text = `orderUpdate response: ${JSON.stringify(updateData, null, 2)}`;
            }

            response = {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                content: [
                  {
                    type: "text",
                    text,
                  },
                ],
              },
            };
          } else {
            sendError(msg.id, -32602, `Unknown tool: ${name}`);
            return;
          }
          break;

        case "notifications/initialized":
          // This is a notification, no response needed
          console.error("[MCP Server] Client initialized");
          return;

        default:
          sendError(msg.id, -32601, `Method not found: ${msg.method}`);
          return;
      }

      console.error(`[MCP Server] Sending response for: ${msg.method}`);
      sendResponse(response);
    } catch (err) {
      console.error(`[MCP Server] Error processing request:`, err);
      sendError(msg.id, -32603, `Internal error: ${err.message}`);
    }
  } catch (err) {
    // JSON parse error - incomplete message, keep buffering
    console.error(`[MCP Server] Buffering incomplete JSON...`);
  }
});

rl.on("close", () => {
  console.error("[MCP Server] Connection closed");
  process.exit(0);
});

// Handle process errors
process.on("uncaughtException", (err) => {
  console.error(`[MCP Server] Uncaught exception:`, err);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error(`[MCP Server] Unhandled rejection:`, err);
  process.exit(1);
});

console.error("[MCP Server] Started and ready");
