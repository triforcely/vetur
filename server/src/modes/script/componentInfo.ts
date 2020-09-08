import * as ts from 'typescript';
import {
  VueFileInfo,
  PropInfo,
  ComputedInfo,
  DataInfo,
  MethodInfo,
  ChildComponent,
  EventInfo
} from '../../services/vueInfoService';
import { getChildComponents } from './childComponents';
import { T_TypeScript } from '../../services/dependencyService';
import { TextDocument, Range } from 'vscode-languageserver-types';

export function getComponentInfo(
  tsModule: T_TypeScript,
  service: ts.LanguageService,
  fileFsPath: string,
  config: any
): VueFileInfo | undefined {
  const program = service.getProgram();
  if (!program) {
    return undefined;
  }

  const sourceFile = program.getSourceFile(fileFsPath);
  if (!sourceFile) {
    return undefined;
  }

  const checker = program.getTypeChecker();

  const defaultExportNode = getDefaultExportNode(tsModule, sourceFile);
  if (!defaultExportNode) {
    return undefined;
  }

  // This virtual source document is needed to calculate positions in the file
  const sourceDoc = TextDocument.create(sourceFile.fileName, '', 0, sourceFile.getFullText());
  const vueFileInfo = analyzeDefaultExportExpr(tsModule, defaultExportNode, checker, sourceDoc);

  const defaultExportType = checker.getTypeAtLocation(defaultExportNode);
  const internalChildComponents = getChildComponents(
    tsModule,
    defaultExportType,
    checker,
    config.vetur.completion.tagCasing
  );

  if (internalChildComponents) {
    const childComponents: ChildComponent[] = [];
    internalChildComponents.forEach(c => {
      childComponents.push({
        name: c.name,
        documentation: c.documentation,
        definition: c.definition,
        info: c.defaultExportNode
          ? analyzeDefaultExportExpr(tsModule, c.defaultExportNode, checker, c.componentDocument)
          : undefined
      });
    });
    vueFileInfo.componentInfo.childComponents = childComponents;
  }

  return vueFileInfo;
}

export function analyzeDefaultExportExpr(
  tsModule: T_TypeScript,
  defaultExportNode: ts.Node,
  checker: ts.TypeChecker,
  doc: TextDocument
): VueFileInfo {
  const defaultExportType = checker.getTypeAtLocation(defaultExportNode);

  const props = getProps(tsModule, defaultExportType, checker, doc);
  const data = getData(tsModule, defaultExportType, checker, doc);
  const computed = getComputed(tsModule, defaultExportType, checker, doc);
  const methods = getMethods(tsModule, defaultExportType, checker, doc);
  const events = getEvents(tsModule, defaultExportType, checker, doc);

  return {
    componentInfo: {
      props,
      data,
      computed,
      methods,
      events,
      position: getRangeFromNode(doc, defaultExportNode)
    }
  };
}

export function getDefaultExportNode(tsModule: T_TypeScript, sourceFile: ts.SourceFile): ts.Node | undefined {
  const exportStmts = sourceFile.statements.filter(
    st => st.kind === tsModule.SyntaxKind.ExportAssignment || st.kind === tsModule.SyntaxKind.ClassDeclaration
  );
  if (exportStmts.length === 0) {
    return undefined;
  }
  const exportNode =
    exportStmts[0].kind === tsModule.SyntaxKind.ExportAssignment
      ? (exportStmts[0] as ts.ExportAssignment).expression
      : (exportStmts[0] as ts.ClassDeclaration);

  return getNodeFromExportNode(tsModule, exportNode);
}

function getProps(
  tsModule: T_TypeScript,
  defaultExportType: ts.Type,
  checker: ts.TypeChecker,
  doc: TextDocument
): PropInfo[] | undefined {
  const result: PropInfo[] = getClassAndObjectInfo(ts, defaultExportType, checker, doc, getClassProps, getObjectProps);
  return result.length === 0 ? undefined : result;

  function markPropBoundToModel(type: ts.Type, props: PropInfo[]) {
    function markValuePropBoundToModel() {
      return props.map(prop => {
        if (prop.name === 'value') {
          prop.isBoundToModel = true;
        }
        return prop;
      });
    }

    const modelSymbol = checker.getPropertyOfType(type, 'model');
    const modelValue = (modelSymbol?.valueDeclaration as ts.PropertyAssignment)?.initializer;
    // Set value prop when no model def
    if (!modelSymbol || !modelValue) {
      return markValuePropBoundToModel();
    }

    const modelType = checker.getTypeOfSymbolAtLocation(modelSymbol, modelValue);
    const modelPropSymbol = checker.getPropertyOfType(modelType, 'prop');
    const modelPropValue = (modelPropSymbol?.valueDeclaration as ts.PropertyAssignment)?.initializer;
    if (!modelPropValue || !tsModule.isStringLiteral(modelPropValue)) {
      return markValuePropBoundToModel();
    }

    return props.map(prop => {
      if (prop.name === modelPropValue.text) {
        prop.isBoundToModel = true;
      }
      return prop;
    });
  }

  function getPropValidatorInfo(
    propertyValue: ts.Node | undefined
  ): { hasObjectValidator: boolean; required: boolean } {
    if (!propertyValue || !tsModule.isObjectLiteralExpression(propertyValue)) {
      return { hasObjectValidator: false, required: true };
    }

    const propertyValueSymbol = checker.getTypeAtLocation(propertyValue).symbol;
    const requiredValue = propertyValueSymbol?.members?.get('required' as ts.__String)?.valueDeclaration;
    const defaultValue = propertyValueSymbol?.members?.get('default' as ts.__String)?.valueDeclaration;
    if (!requiredValue && !defaultValue) {
      return { hasObjectValidator: false, required: true };
    }

    const required = Boolean(
      requiredValue &&
        tsModule.isPropertyAssignment(requiredValue) &&
        requiredValue?.initializer.kind === tsModule.SyntaxKind.TrueKeyword
    );

    return { hasObjectValidator: true, required };
  }

  function getClassProps(type: ts.Type) {
    const propDecoratorNames = ['Prop', 'Model', 'PropSync'];
    const propsSymbols = type
      .getProperties()
      .filter(
        property =>
          validPropertySyntaxKind(property, tsModule.SyntaxKind.PropertyDeclaration) &&
          getPropertyDecoratorNames(property).some(decoratorName => propDecoratorNames.includes(decoratorName))
      );
    if (propsSymbols.length === 0) {
      return undefined;
    }

    return propsSymbols.map(propSymbol => {
      const prop = propSymbol.valueDeclaration as ts.PropertyDeclaration;
      const decoratorExpr = prop.decorators?.find(decorator =>
        tsModule.isCallExpression(decorator.expression)
          ? propDecoratorNames.includes(decorator.expression.expression.getText())
          : false
      )?.expression as ts.CallExpression;
      const decoratorName = decoratorExpr.expression.getText();
      const [firstNode, secondNode] = decoratorExpr.arguments;
      if (decoratorName === 'PropSync' && tsModule.isStringLiteral(firstNode)) {
        return {
          name: firstNode.text,
          ...getPropValidatorInfo(secondNode),
          isBoundToModel: false,
          documentation: buildDocumentation(tsModule, propSymbol, checker)
        };
      }

      return {
        name: propSymbol.name,
        ...getPropValidatorInfo(decoratorName === 'Model' ? secondNode : firstNode),
        isBoundToModel: decoratorName === 'Model',
        documentation: buildDocumentation(tsModule, propSymbol, checker)
      };
    });
  }

  function getObjectProps(type: ts.Type) {
    const propsSymbol = checker.getPropertyOfType(type, 'props');
    if (!propsSymbol || !propsSymbol.valueDeclaration) {
      return undefined;
    }

    const propsDeclaration = getLastChild(propsSymbol.valueDeclaration);
    if (!propsDeclaration) {
      return undefined;
    }

    /**
     * Plain array props like `props: ['foo', 'bar']`
     */
    if (propsDeclaration.kind === tsModule.SyntaxKind.ArrayLiteralExpression) {
      return (propsDeclaration as ts.ArrayLiteralExpression).elements
        .filter(expr => expr.kind === tsModule.SyntaxKind.StringLiteral)
        .map(expr => {
          return {
            name: (expr as ts.StringLiteral).text,
            hasObjectValidator: false,
            required: true,
            isBoundToModel: false,
            documentation: `\`\`\`js\n${formatJSLikeDocumentation(
              propsDeclaration.parent.getFullText().trim()
            )}\n\`\`\`\n`
          };
        });
    }

    /**
     * Object literal props like
     * ```
     * {
     *   props: {
     *     foo: { type: Boolean, default: true },
     *     bar: { type: String, default: 'bar' },
     *     car: String
     *   }
     * }
     * ```
     */
    if (propsDeclaration.kind === tsModule.SyntaxKind.ObjectLiteralExpression) {
      const propsType = checker.getTypeOfSymbolAtLocation(propsSymbol, propsDeclaration);

      return checker.getPropertiesOfType(propsType).map(s => {
        const status = tsModule.isPropertyAssignment(s.valueDeclaration)
          ? getPropValidatorInfo(s.valueDeclaration.initializer)
          : { hasObjectValidator: false, required: true };

        return {
          name: s.name,
          ...status,
          isBoundToModel: false,
          documentation: buildDocumentation(tsModule, s, checker)
        };
      });
    }

    return undefined;
  }
}

/**
 * In SFC, data can only be a function
 * ```
 * {
 *   data() {
 *     return {
 *        foo: true,
 *        bar: 'bar'
 *     }
 *   }
 * }
 * ```
 */
function getData(
  tsModule: T_TypeScript,
  defaultExportType: ts.Type,
  checker: ts.TypeChecker,
  doc: TextDocument
): DataInfo[] | undefined {
  const result: DataInfo[] = getClassAndObjectInfo(
    tsModule,
    defaultExportType,
    checker,
    doc,
    getClassData,
    getObjectData
  );

  return result.length === 0 ? undefined : result;

  function getClassData(type: ts.Type) {
    const noDataDecoratorNames = ['Prop', 'Model', 'Provide', 'ProvideReactive', 'Ref'];
    const dataSymbols = type
      .getProperties()
      .filter(
        property =>
          validPropertySyntaxKind(property, tsModule.SyntaxKind.PropertyDeclaration) &&
          !getPropertyDecoratorNames(property).some(decoratorName => noDataDecoratorNames.includes(decoratorName)) &&
          !property.name.startsWith('_') &&
          !property.name.startsWith('$')
      );
    if (dataSymbols.length === 0) {
      return undefined;
    }

    return dataSymbols.map(data => {
      return {
        name: data.name,
        documentation: buildDocumentation(tsModule, data, checker)
      };
    });
  }

  function getObjectData(type: ts.Type) {
    const dataSymbol = checker.getPropertyOfType(type, 'data');
    if (!dataSymbol || !dataSymbol.valueDeclaration) {
      return undefined;
    }

    const dataType = checker.getTypeOfSymbolAtLocation(dataSymbol, dataSymbol.valueDeclaration);
    const dataSignatures = dataType.getCallSignatures();
    if (dataSignatures.length === 0) {
      return undefined;
    }
    const dataReturnTypeProperties = checker.getReturnTypeOfSignature(dataSignatures[0]);
    return dataReturnTypeProperties.getProperties().map(s => {
      return {
        name: s.name,
        documentation: buildDocumentation(tsModule, s, checker)
      };
    });
  }
}

function getComputed(
  tsModule: T_TypeScript,
  defaultExportType: ts.Type,
  checker: ts.TypeChecker,
  doc: TextDocument
): ComputedInfo[] | undefined {
  const result: ComputedInfo[] = getClassAndObjectInfo(
    tsModule,
    defaultExportType,
    checker,
    doc,
    getClassComputed,
    getObjectComputed
  );
  return result.length === 0 ? undefined : result;

  function getClassComputed(type: ts.Type) {
    const getAccessorSymbols = type
      .getProperties()
      .filter(property => property.valueDeclaration?.kind === tsModule.SyntaxKind.GetAccessor);
    const setAccessorSymbols = defaultExportType
      .getProperties()
      .filter(property => property.valueDeclaration?.kind === tsModule.SyntaxKind.SetAccessor);
    if (getAccessorSymbols.length === 0) {
      return undefined;
    }

    return getAccessorSymbols.map(computed => {
      const setComputed = setAccessorSymbols.find(setAccessor => setAccessor.name === computed.name);
      return {
        name: computed.name,
        documentation:
          buildDocumentation(tsModule, computed, checker) +
          (setComputed !== undefined ? buildDocumentation(tsModule, setComputed, checker) : '')
      };
    });
  }

  function getObjectComputed(type: ts.Type) {
    const computedSymbol = checker.getPropertyOfType(type, 'computed');
    if (!computedSymbol || !computedSymbol.valueDeclaration) {
      return undefined;
    }

    const computedDeclaration = getLastChild(computedSymbol.valueDeclaration);
    if (!computedDeclaration) {
      return undefined;
    }

    if (computedDeclaration.kind === tsModule.SyntaxKind.ObjectLiteralExpression) {
      const computedType = checker.getTypeOfSymbolAtLocation(computedSymbol, computedDeclaration);

      return checker.getPropertiesOfType(computedType).map(s => {
        return {
          name: s.name,
          documentation: buildDocumentation(tsModule, s, checker)
        };
      });
    }
  }
}

function isInternalHook(methodName: string) {
  const $internalHooks = [
    'data',
    'beforeCreate',
    'created',
    'beforeMount',
    'mounted',
    'beforeDestroy',
    'destroyed',
    'beforeUpdate',
    'updated',
    'activated',
    'deactivated',
    'render',
    'errorCaptured', // 2.5
    'serverPrefetch' // 2.6
  ];
  return $internalHooks.includes(methodName);
}

function getMethods(
  tsModule: T_TypeScript,
  defaultExportType: ts.Type,
  checker: ts.TypeChecker,
  doc: TextDocument
): MethodInfo[] | undefined {
  const result: MethodInfo[] = getClassAndObjectInfo(
    tsModule,
    defaultExportType,
    checker,
    doc,
    getClassMethods,
    getObjectMethods
  );
  return result.length === 0 ? undefined : result;

  function getClassMethods(type: ts.Type, checker: ts.TypeChecker) {
    const methodSymbols = type
      .getProperties()
      .filter(
        property =>
          validPropertySyntaxKind(property, tsModule.SyntaxKind.MethodDeclaration) &&
          !getPropertyDecoratorNames(property).some(decoratorName => decoratorName === 'Watch') &&
          !isInternalHook(property.name)
      );
    if (methodSymbols.length === 0) {
      return undefined;
    }

    return methodSymbols.map(method => {
      const methodInfo: MethodInfo = {
        name: method.name,
        documentation: buildDocumentation(tsModule, method, checker),
        position: getRangeFromNode(doc, method.valueDeclaration)
      };

      return methodInfo;
    });
  }

  function getObjectMethods(type: ts.Type, checker: ts.TypeChecker) {
    const methodsSymbol = checker.getPropertyOfType(type, 'methods');
    if (!methodsSymbol || !methodsSymbol.valueDeclaration) {
      return undefined;
    }

    const methodsDeclaration = getLastChild(methodsSymbol.valueDeclaration);
    if (!methodsDeclaration) {
      return undefined;
    }

    if (methodsDeclaration.kind === tsModule.SyntaxKind.ObjectLiteralExpression) {
      const methodsType = checker.getTypeOfSymbolAtLocation(methodsSymbol, methodsDeclaration);

      return checker.getPropertiesOfType(methodsType).map(s => {
        return {
          name: s.name,
          documentation: buildDocumentation(tsModule, s, checker)
        };
      });
    }
  }
}

function getEvents(
  tsModule: T_TypeScript,
  defaultExportType: ts.Type,
  checker: ts.TypeChecker,
  doc: TextDocument
): EventInfo[] | undefined {
  const result: EventInfo[] = getClassAndObjectInfo(
    tsModule,
    defaultExportType,
    checker,
    doc,
    getClassEvents,
    getObjectEvents
  );

  return result.length === 0 ? undefined : result;

  function getClassEvents(type: ts.Type, checker: ts.TypeChecker, doc: TextDocument) {
    const methodSymbols = type
      .getProperties()
      .filter(
        property =>
          getPropertyDecoratorNames(property).some(decoratorName => decoratorName === 'Emit') &&
          !isInternalHook(property.name)
      );
    if (methodSymbols.length === 0) {
      return undefined;
    }

    return methodSymbols.flatMap(method => {
      const decorators = getPropertyDecorators(method, tsModule.SyntaxKind.MethodDeclaration);
      return decorators.map(d => {
        const documentationData = buildDocumentationForEvent(tsModule, method, d, checker);
        const methodInfo: MethodInfo = {
          name: documentationData.eventName || method.name,
          documentation: documentationData.documentation,
          position: getRangeFromNode(doc, d.expression)
        };

        return methodInfo;
      });
    });
  }

  function getObjectEvents(type: ts.Type, checker: ts.TypeChecker, doc: TextDocument): MethodInfo[] {
    // PoC: automatically detect events from this.$emit(...) calls
    try {
      const foundEvents: MethodInfo[] = [];

      for (const property of type.getProperties()) {
        property.valueDeclaration.forEachChild(child => readEventsFromChild(child, foundEvents));
      }

      return foundEvents;
    } catch (e) {
      return [];
    }
  }

  function readEventsFromChild(child: ts.Node, foundEvents: any[]) {
    if (child.kind === ts.SyntaxKind.SyntaxList && child.getText().startsWith('this.$emit')) {
      const eventInfo = parseEmitNode(child);
      if (eventInfo) {
        foundEvents.push(eventInfo);
      }
    }
    const children = child.getChildren();
    if (children.length > 0) {
      children.forEach(c => readEventsFromChild(c, foundEvents));
    }
  }

  function parseEmitNode(node: ts.Node): MethodInfo | null {
    while (true) {
      if (node.getChildCount() === 0) {
        return null;
      }

      const nodeChildren = node.getChildren();
      if (nodeChildren[0].getText() !== 'this.$emit') {
        node = node.getChildAt(0);
        continue;
      }

      const emitArguments = nodeChildren[2].getChildren().filter(x => x.kind !== ts.SyntaxKind.CommaToken);

      if (!emitArguments.length) {
        return null;
      }

      const eventIdentifier = emitArguments.shift();

      if (!eventIdentifier || eventIdentifier.kind !== ts.SyntaxKind.StringLiteral) {
        return null;
      }
      let argPos = 0;
      const possibleTypes = emitArguments.map(x => ({
        typeName: checker.typeToString(checker.getTypeAtLocation(x)),
        name: x.kind === ts.SyntaxKind.Identifier ? x.getText() : `arg${++argPos}`
      }));

      const argumentList = possibleTypes.map(t => `${t.name}: ${t.typeName}`).join(', ');

      return {
        name: (eventIdentifier as ts.StringLiteral).text,
        position: getRangeFromNode(doc, node),
        documentation: `\`\`\`js\n(${argumentList}) => void\n\`\`\`\n`
      };
    }
  }
}

function getNodeFromExportNode(tsModule: T_TypeScript, exportExpr: ts.Node): ts.Node | undefined {
  switch (exportExpr.kind) {
    case tsModule.SyntaxKind.CallExpression:
      // Vue.extend or synthetic __vueEditorBridge
      return (exportExpr as ts.CallExpression).arguments[0];
    case tsModule.SyntaxKind.ObjectLiteralExpression:
      return exportExpr as ts.ObjectLiteralExpression;
    case tsModule.SyntaxKind.ClassDeclaration:
      return exportExpr as ts.ClassDeclaration;
  }
  return undefined;
}

export function getLastChild(d: ts.Declaration) {
  const children = d.getChildren();
  if (children.length === 0) {
    return undefined;
  }

  return children[children.length - 1];
}

export function isClassType(tsModule: T_TypeScript, type: ts.Type) {
  if (type.isClass === undefined) {
    return !!(
      (type.flags & tsModule.TypeFlags.Object ? (type as ts.ObjectType).objectFlags : 0) & tsModule.ObjectFlags.Class
    );
  } else {
    return type.isClass();
  }
}

export function getClassDecoratorArgumentType(
  tsModule: T_TypeScript,
  defaultExportType: ts.Type,
  checker: ts.TypeChecker
) {
  const decorators = defaultExportType.symbol.valueDeclaration.decorators;
  if (!decorators || decorators.length === 0) {
    return undefined;
  }

  if (!tsModule.isCallExpression(decorators?.[0].expression)) {
    return undefined;
  }

  const decoratorArguments = decorators?.[0].expression?.arguments;
  if (!decoratorArguments || decoratorArguments.length === 0) {
    return undefined;
  }

  return checker.getTypeAtLocation(decoratorArguments[0]);
}

function getClassAndObjectInfo<C, O>(
  tsModule: T_TypeScript,
  defaultExportType: ts.Type,
  checker: ts.TypeChecker,
  doc: TextDocument,
  getClassResult: (type: ts.Type, checker: ts.TypeChecker, doc: TextDocument) => C[] | undefined,
  getObjectResult: (type: ts.Type, checker: ts.TypeChecker, doc: TextDocument) => O[] | undefined
) {
  const result: Array<C | O> = [];
  if (isClassType(tsModule, defaultExportType)) {
    result.push.apply(result, getClassResult(defaultExportType, checker, doc) || []);
    const decoratorArgumentType = getClassDecoratorArgumentType(tsModule, defaultExportType, checker);
    if (decoratorArgumentType) {
      result.push.apply(result, getObjectResult(decoratorArgumentType, checker, doc) || []);
    }
  } else {
    result.push.apply(result, getObjectResult(defaultExportType, checker, doc) || []);
  }
  return result;
}

function getNodeFromSymbol(property: ts.Symbol): ts.Declaration | undefined {
  return property.valueDeclaration ?? property.declarations?.[0];
}

function validPropertySyntaxKind(property: ts.Symbol, checkSyntaxKind: ts.SyntaxKind): boolean {
  return getNodeFromSymbol(property)?.kind === checkSyntaxKind;
}

function getPropertyDecoratorNames(property: ts.Symbol): string[] {
  const decorators = getNodeFromSymbol(property)?.decorators;
  if (decorators === undefined) {
    return [];
  }

  return decorators
    .map(decorator => decorator.expression as ts.CallExpression)
    .filter(decoratorExpression => decoratorExpression.expression !== undefined)
    .map(decoratorExpression => decoratorExpression.expression.getText());
}

export function getPropertyDecorators(property: ts.Symbol, checkSyntaxKind: ts.SyntaxKind): ts.NodeArray<ts.Decorator> {
  if (
    property?.valueDeclaration?.kind !== checkSyntaxKind ||
    property.declarations.length === 0 ||
    property.declarations[0].decorators === undefined
  ) {
    const emptyArray: ts.Decorator[] = [];
    return ts.createNodeArray(emptyArray);
  }

  return property.declarations[0].decorators;
}

export function buildDocumentation(tsModule: T_TypeScript, s: ts.Symbol, checker: ts.TypeChecker) {
  let documentation = s
    .getDocumentationComment(checker)
    .map(d => d.text)
    .join('\n');

  documentation += '\n';

  const node = getNodeFromSymbol(s);
  if (node) {
    documentation += `\`\`\`js\n${formatJSLikeDocumentation(node.getText())}\n\`\`\`\n`;
  }

  return documentation;
}

export function buildDocumentationForEvent(
  tsModule: T_TypeScript,
  s: ts.Symbol,
  decorator: ts.Decorator,
  checker: ts.TypeChecker
): { documentation: string; eventName: string | null } {
  let documentation = s
    .getDocumentationComment(checker)
    .map(d => d.text)
    .join('\n');

  documentation += '\n';

  let eventName = null;
  let eventTypeName = 'any';
  let originalArgumentsDoc: string[] = [];

  if (s.valueDeclaration) {
    if (s.valueDeclaration.kind === tsModule.SyntaxKind.MethodDeclaration) {
      const methodDeclaration = s.valueDeclaration as ts.MethodDeclaration;
      const decoratorExpr = decorator.expression as ts.CallExpression;
      const hasCustomName = decoratorExpr.arguments && decoratorExpr.arguments.length > 0;

      if (methodDeclaration.parameters.length > 0) {
        originalArgumentsDoc = methodDeclaration.parameters.map(p => p.getText());
      }

      if (hasCustomName) {
        const nameNode = decoratorExpr.arguments[0];
        if (nameNode.kind === tsModule.SyntaxKind.StringLiteral) {
          // Get name of event from decorator argument, e.g. @Emit('myEvent')
          eventName = (nameNode as ts.StringLiteral).text;

          const eventSignature = checker.getSignatureFromDeclaration(methodDeclaration);
          if (eventSignature) {
            const eventType = checker.getReturnTypeOfSignature(eventSignature) as ts.TypeReference;

            if (eventType.typeArguments && eventType.symbol.getName() === 'Promise') {
              // When promise is returned from event method value after resolution is returned to callbacks.
              const resolvedType = getResolvedPromiseType(eventType);
              if (resolvedType) {
                eventTypeName = getNameForType(resolvedType, checker); // Promise<T>
              }
            } else {
              eventTypeName = getNameForType(eventType, checker);
            }
          }
        }
      }
    }

    const originalEventArguments = originalArgumentsDoc.join(', ');

    // Event method parameters are passed to the listener func after return value by (vue-property-decorator)
    documentation +=
      `\`\`\`js\n(e: ${eventTypeName}${originalEventArguments ? ', ' + originalEventArguments : ''}) ` +
      `=> void\n\`\`\`\n`;
  }
  return {
    documentation,
    eventName
  };
}

function getResolvedPromiseType(type: ts.TypeReference): ts.Type | null {
  try {
    if (!type.typeArguments || type.typeArguments.length === 0) {
      return null;
    }

    return type.typeArguments[0];
  } catch (e) {
    return null;
  }
}

function getNameForType(type: ts.Type, checker: ts.TypeChecker): string {
  try {
    return checker.typeToString(type);
  } catch (e) {
    return 'unknown'; // TODO: unable to deduce event type, log error?
  }
}

function formatJSLikeDocumentation(src: string): string {
  const segments = src.split('\n');
  if (segments.length === 1) {
    return src;
  }

  const spacesToDeindent = segments[segments.length - 1].search(/\S/);

  return (
    segments[0] +
    '\n' +
    segments
      .slice(1)
      .map(s => s.slice(spacesToDeindent))
      .join('\n')
  );
}

function getRangeFromNode(doc: TextDocument, node: ts.Node) {
  return Range.create(doc.positionAt(node.pos), doc.positionAt(node.end));
}
